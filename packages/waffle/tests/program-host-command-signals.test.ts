import { afterEach, expect, test } from "bun:test";
import { createRuntime, type Runtime } from "../runtime.js";
import { defineProgramPackage } from "../programs/catalog.js";
import type { ProgramPackage } from "../programs/index.js";
import {
  CommandStdioError,
  type HostCommandContext,
  type DelegatedSignals,
  type SignalSend,
} from "../proc/command.js";
import { ProcessError } from "../proc/types.js";
import { commandShell } from "./program-host-command-fixture.js";

let runtime: Runtime | undefined;
let cleanup: Array<() => void | Promise<void>> = [];
let releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases) release();
  releases = [];
  await runtime?.dispose();
  runtime = undefined;
  for (const close of cleanup.toReversed()) await close();
  cleanup = [];
});
function create(): Runtime {
  return (runtime = createRuntime({
    filesystem: { mode: "memory", workerURL: new URL("../browser/fs-worker.ts", import.meta.url) },
  }));
}
function deferred() {
  const result = Promise.withResolvers<void>();
  releases.push(result.resolve);
  return result;
}
function fixture() {
  const contexts = new Map<number, HostCommandContext>();
  const deliveries: SignalSend[] = [];
  const entered = new Map<string, ReturnType<typeof deferred>>();
  const pkg = defineProgramPackage({
    name: "trusted",
    programs: [
      {
        path: "/target",
        command: {
          load: async () => async (context: HostCommandContext) => {
            contexts.set(context.pid, context);
            entered.get("target")?.resolve();
            await new Promise<void>((resolve) => {
              if (context.abort.aborted) resolve();
              else context.abort.addEventListener("abort", () => resolve(), { once: true });
            });
            return 0;
          },
        },
      },
      {
        path: "/control",
        aliases: ["/alias"],
        command: {
          signals: "delegated",
          load: async () => async (context: HostCommandContext) => {
            contexts.set(context.pid, context);
            entered.get("control")?.resolve();
            if (context.request.argv[1] === "term") {
              const target = context.processes
                .snapshot()
                .find((row) => row.pid === Number(context.request.argv[2]));
              if (!target || !context.signals) throw new Error("Missing granted target");
              deliveries.push(context.signals.send(target.pid, 15));
            }
            await hold.promise;
            return 0;
          },
        },
      },
      {
        path: "/query",
        command: {
          load: async () => async (context: HostCommandContext) => {
            contexts.set(context.pid, context);
            entered.get("query")?.resolve();
            await hold.promise;
            return 0;
          },
        },
      },
    ],
  });
  const hold = deferred();
  return {
    pkg,
    contexts,
    deliveries,
    hold,
    gate(name: string) {
      const gate = deferred();
      entered.set(name, gate);
      return gate.promise;
    },
  };
}

test("the actual root controller grants an installed package real sibling TERM delivery", async () => {
  const owner = create();
  const f = fixture();
  await owner.programs.onDemand(f.pkg.pick("target", "control"));
  const shell = await commandShell(owner, cleanup, { signalDelegation: { packages: [f.pkg] } });
  const target = await shell.spawn("/target");
  const control = await shell.spawn("/alias", ["control", "term", String(target.pid)]);
  const context = f.contexts.get(control.pid)!;
  expect(context.signals).not.toBeNull();
  expect(shell.supervisor.canSignal(control.pid, target.pid)).toBe(false);
  expect(shell.supervisor.canSignal(shell.root, target.pid)).toBe(true);
  expect(context.processes.snapshot().map((row) => row.pid)).toEqual([control.pid]);
  const send = context.signals!.send;
  expect(f.deliveries).toEqual(["sent"]);
  expect(await target.collect()).toMatchObject({ kind: "signaled", code: 15 });
  expect(send(target.pid, 15)).toBe("missing");
  f.hold.resolve();
  await control.collect();
  expect(send(target.pid, 15)).toBe("revoked");
});

test("delegation defaults to absent and definitions must explicitly request it", async () => {
  const owner = create();
  const f = fixture();
  await owner.programs.onDemand(f.pkg);
  const untrustedRoot = await commandShell(owner, cleanup);
  const denied = await untrustedRoot.spawn("/control");
  expect(f.contexts.get(denied.pid)!.signals).toBeNull();
  const trustingRoot = await commandShell(owner, cleanup, {
    signalDelegation: { packages: [f.pkg] },
  });
  const query = await trustingRoot.spawn("/query");
  expect(f.contexts.get(query.pid)!.signals).toBeNull();
  f.hold.resolve();
  await denied.collect();
  await query.collect();
});

test("a foreign package, even at the same path after reinstall, cannot inherit a trust grant", async () => {
  const owner = create();
  const f = fixture();
  await owner.programs.onDemand(f.pkg.pick("control"));
  const shell = await commandShell(owner, cleanup, { signalDelegation: { packages: [f.pkg] } });
  await owner.programs.get("control")!.remove();
  let granted: DelegatedSignals | null | undefined;
  const foreign: ProgramPackage = {
    name: "trusted",
    programs: [
      {
        path: "/control",
        command: {
          signals: "delegated",
          load:
            async () =>
            async ({ signals }) => {
              granted = signals;
              return 0;
            },
        },
      },
    ],
  };
  await owner.programs.onDemand(foreign);
  expect(await (await shell.spawn("/control")).collect()).toMatchObject({ code: 0 });
  expect(granted).toBeNull();
});

test("grants deny the root, cross-root and forged targets, and validate current signals first", async () => {
  const owner = create();
  const f = fixture();
  await owner.programs.onDemand(f.pkg);
  const shell = await commandShell(owner, cleanup, { signalDelegation: { packages: [f.pkg] } });
  const other = await commandShell(owner, cleanup);
  const target = await other.spawn("/target");
  const control = await shell.spawn("/control");
  const context = f.contexts.get(control.pid)!;
  const grant = context.signals!;
  expect(grant.send(target.pid, 15)).toBe("denied");
  expect(grant.send(shell.root, 15)).toBe("denied");
  expect(Reflect.apply(grant.send, { anchor: other.root, pid: target.pid }, [target.pid, 15])).toBe(
    "denied",
  );
  expect(Reflect.apply(grant.send, undefined, [{ pid: target.pid, rootPid: shell.root }, 15])).toBe(
    "missing",
  );
  for (const signal of [0, 19, 32, 65])
    expect(() => grant.send(target.pid, signal)).toThrow(ProcessError);
  expect(other.supervisor.get(target.pid)?.result).toBeNull();
  expect(shell.supervisor.get(shell.root)?.result).toBeNull();
  expect(context.processes.snapshot().map((row) => row.pid)).toEqual([control.pid]);
  await other.service.kill(target.pid, 15);
  await target.collect();
  f.hold.resolve();
  await control.collect();
  expect(grant.send(target.pid, 15)).toBe("revoked");
  expect(() => grant.send(target.pid, 0)).toThrow(ProcessError);
});

test("removal revokes retained grants synchronously while the callback still owns its task", async () => {
  const owner = create();
  const f = fixture();
  await owner.programs.onDemand(f.pkg);
  const shell = await commandShell(owner, cleanup, { signalDelegation: { packages: [f.pkg] } });
  const target = await shell.spawn("/target");
  const control = await shell.spawn("/control");
  const context = f.contexts.get(control.pid)!;
  const remove = owner.programs.get("control")!.remove();
  expect(context.signals!.send(target.pid, 15)).toBe("revoked");
  expect(() => context.processes.snapshot()).toThrow(CommandStdioError);
  expect(shell.supervisor.get(target.pid)?.result).toBeNull();
  await shell.service.kill(target.pid, 15);
  await target.collect();
  f.hold.resolve();
  await control.collect();
  await remove;
});

test("root exit and runtime disposal revoke grants without mutating the guest policy", async () => {
  const owner = create();
  const f = fixture();
  await owner.programs.onDemand(f.pkg);
  const shell = await commandShell(owner, cleanup, { signalDelegation: { packages: [f.pkg] } });
  const control = await shell.spawn("/control");
  const context = f.contexts.get(control.pid)!;
  await shell.service.rootExit(shell.root, 0);
  expect(context.signals!.send(control.pid, 15)).toBe("revoked");
  expect(() => context.processes.snapshot()).toThrow(CommandStdioError);
  const disposal = owner.dispose();
  expect(context.signals!.send(control.pid, 15)).toBe("revoked");
  f.hold.resolve();
  await control.exit;
  await disposal;
});

test("process snapshots are root-local copies without environment or control authority", async () => {
  const owner = create();
  const f = fixture();
  await owner.programs.onDemand(f.pkg);
  const shell = await commandShell(owner, cleanup);
  const foreign = await commandShell(owner, cleanup);
  const local = await shell.spawn("/query", ["query", "original"]);
  const other = await foreign.spawn("/query", ["query", "private"]);
  const context = f.contexts.get(local.pid)!;
  const rows = context.processes.snapshot();
  expect(rows.map((row) => row.pid)).toEqual([local.pid]);
  expect(Object.keys(rows[0]!).sort()).toEqual(["argv", "executable", "parentPid", "pid", "state"]);
  Reflect.set(rows[0]!.argv, 0, "forged");
  Reflect.set(rows[0]!, "parentPid", foreign.root);
  expect(context.processes.snapshot()).toMatchObject([
    { parentPid: shell.root, argv: ["query", "original"] },
  ]);
  f.hold.resolve();
  await local.collect();
  await other.collect();
  expect(() => context.processes.snapshot()).toThrow(CommandStdioError);
});

test("root policy captures package identities before later option mutation", async () => {
  const owner = create();
  const f = fixture();
  await owner.programs.onDemand(f.pkg);
  const allowed: ProgramPackage[] = [];
  const shell = await commandShell(owner, cleanup, { signalDelegation: { packages: allowed } });
  allowed.push(f.pkg);
  const control = await shell.spawn("/control");
  expect(f.contexts.get(control.pid)!.signals).toBeNull();
  f.hold.resolve();
  await control.collect();
});
