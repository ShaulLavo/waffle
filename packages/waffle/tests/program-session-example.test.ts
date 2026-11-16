import { afterEach, expect, spyOn, test } from "bun:test";
import type { RuntimeOptions } from "../index.js";
import * as sdk from "../index.js";
import { defineProgramPackage } from "../programs/catalog.js";
import { ProgramSession } from "../examples/program-session.js";
import { DescriptorTable } from "../core/descriptors.js";
import { SharedFilesystem } from "../browser/shared-fs.js";
import { createProgramShell } from "./fixtures/program-shell.js";

const session = new ProgramSession();
const releases: Array<() => void> = [];
const tables: DescriptorTable[] = [];
const options: RuntimeOptions = {
  filesystem: { mode: "memory", workerURL: new URL("../browser/fs-worker.ts", import.meta.url) },
};
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await session.close();
  for (const table of tables.splice(0)) table.dispose();
});

function deferred() {
  const gate = Promise.withResolvers<void>();
  releases.push(gate.resolve);
  return gate;
}

function rejection(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => {
      throw new Error("Expected rejection");
    },
    (error: unknown) => error,
  );
}

function command(name = "tool", fail = false) {
  const started = deferred();
  const finish = deferred();
  const disposeStarted = deferred();
  const disposeFinish = deferred();
  let attempts = 0;
  let disposals = 0;
  const error = new Error("optional tool unavailable");
  const pkg = defineProgramPackage({
    name,
    programs: [
      {
        path: `/bin/${name}`,
        command: {
          load: async () => {
            attempts++;
            started.resolve();
            await finish.promise;
            if (fail && attempts === 1) throw error;
            return async () => 0;
          },
        },
      },
    ],
    dispose: async () => {
      disposals++;
      disposeStarted.resolve();
      await disposeFinish.promise;
    },
  });
  return {
    pkg,
    started,
    finish,
    disposeStarted,
    disposeFinish,
    error,
    attempts: () => attempts,
    disposals: () => disposals,
  };
}

function active() {
  const snapshot = session.snapshot();
  if (snapshot.kind !== "active") throw new Error(`Expected active, got ${snapshot.kind}`);
  return snapshot;
}

function runtime() {
  const owner = session.runtime();
  if (!owner) throw new Error("Expected runtime");
  return owner;
}

test("startup preparation is unknown until successful; failure remains failed and retry uses the same collection", async () => {
  const tool = command("tool", true);
  const opening = session.open({ ...options, programs: { preload: [tool.pkg] } });
  const failure = rejection(opening);
  await tool.started.promise;
  expect(active().catalog).toEqual({ kind: "unknown" });
  expect(runtime().programs.get("tool")?.state.kind).toBe("preparing");
  tool.finish.resolve();
  expect(await failure).toBe(tool.error);
  expect(active().catalog).toMatchObject({ kind: "failed", error: tool.error });
  expect(runtime().programs.get("tool")?.state).toEqual({ kind: "error", error: tool.error });
  await runtime().programs.onDemand({
    name: "working",
    programs: [{ path: "/bin/working", command: { load: async () => async () => 0 } }],
  });
  const shell = await createProgramShell(runtime(), tables);
  expect(await shell.exec("/bin/working", ["working"])).toMatchObject({ kind: "exited", code: 0 });
  expect(active().catalog.kind).toBe("failed");
  await session.preload();
  expect(active().catalog.kind).toBe("failed");

  expect(await session.preload("tool")).toBe("completed");
  const catalog = active().catalog;
  expect(catalog.kind).toBe("failed");
  if (catalog.kind !== "failed") throw new Error("Expected original startup failure after retry");
  expect(catalog.programs).toEqual(runtime().programs.status());
  expect(catalog.programs[0]?.state.kind).toBe("loaded");
  expect(tool.attempts()).toBe(2);
});

test("rejected work leaves the next queued operation usable and the shell keeps working", async () => {
  const tool = command("tool", true);
  await session.open({ ...options, programs: { onDemand: [tool.pkg] } });
  const first = session.preload("tool");
  const failure = rejection(first);
  const retry = session.preload("tool");
  await tool.started.promise;
  tool.finish.resolve();
  expect(await failure).toBe(tool.error);
  expect(await retry).toBe("completed");
  expect(active().preparation).toEqual({ kind: "loaded" });
  expect(tool.attempts()).toBe(2);
  const shell = await createProgramShell(runtime(), tables);
  expect(await shell.exec("/bin/tool", ["tool"])).toMatchObject({ kind: "exited", code: 0 });
});

for (const reset of ["reopen", "close"] as const) {
  test(`${reset} during the preparation dequeue wait returns superseded`, async () => {
    await session.open(options);
    const pending = session.preload();
    const outcome = pending.then(
      (result) => ({ kind: "result", result }),
      (error: unknown) => ({ kind: "error", error }),
    );
    await Promise.resolve();
    const replacement = reset === "reopen" ? session.open(options) : session.close();
    expect(await outcome).toEqual({ kind: "result", result: "superseded" });
    await replacement;
    expect(session.snapshot().kind).toBe(reset === "reopen" ? "active" : "closed");
  });
}

for (const fail of [false, true]) {
  test(`reopen during preparation suppresses stale completion, fail=${fail}, and dequeues into the replacement`, async () => {
    const old = command("old", fail);
    const next = command("next");
    await session.open({ ...options, programs: { onDemand: [old.pkg] } });
    const previous = runtime();
    const loading = session.preload("old");
    await old.started.promise;
    const queued = session.preload(next.pkg);
    const opening = session.open(options);
    expect(session.snapshot()).toEqual({ kind: "opening" });
    expect(session.runtime()).toBeUndefined();
    // Logical cancellation does not prove the source callback or payload cleanup stopped.
    expect(old.disposals()).toBe(0);
    old.finish.resolve();
    expect(await loading).toBe("superseded");
    await old.disposeStarted.promise;
    expect(previous.disposed).toBe(true);
    expect(session.snapshot()).toEqual({ kind: "opening" });
    old.disposeFinish.resolve();
    expect(await opening).toBe("completed");
    await next.started.promise;
    expect(runtime()).not.toBe(previous);
    expect(runtime().programs.get("old")).toBeUndefined();
    expect(runtime().programs.get("next")?.state.kind).toBe("preparing");
    next.finish.resolve();
    expect(await queued).toBe("completed");
    expect(active().preparation).toEqual({ kind: "loaded" });
    expect(runtime().programs.get("next")?.state.kind).toBe("loaded");
  });
}

test("late startup success and failure cannot change a reopened session", async () => {
  for (const fail of [false, true]) {
    const old = command("old", fail);
    const opening = session.open({ ...options, programs: { preload: [old.pkg] } });
    await old.started.promise;
    const replacement = session.open(options);
    old.finish.resolve();
    expect(await opening).toBe("superseded");
    await old.disposeStarted.promise;
    old.disposeFinish.resolve();
    expect(await replacement).toBe("completed");
    expect(active().catalog).toEqual({ kind: "known", programs: [] });
    expect(active().preparation).toEqual({ kind: "idle" });
  }
});

test("terminal and agent mutations refresh from the collection, including known absence", async () => {
  const tool = command();
  await session.open(options);
  expect(active().catalog).toEqual({ kind: "known", programs: [] });
  await runtime().programs.onDemand(tool.pkg);
  const handle = runtime().programs.get("tool")!;
  expect(active().catalog).toEqual({ kind: "known", programs: [handle] });
  const external = runtime().programs.preload("tool");
  await tool.started.promise;
  expect(handle.state.kind).toBe("preparing");
  tool.finish.resolve();
  await external;
  expect(active().catalog).toEqual({ kind: "known", programs: [handle] });
  expect(handle.state.kind).toBe("loaded");
  tool.disposeFinish.resolve();
  await handle.remove();
  expect(active().catalog).toEqual({ kind: "known", programs: [] });
});

test("failed installation probe stays failed instead of publishing an empty program list", async () => {
  const error = new Error("installation probe failed");
  const probe = spyOn(SharedFilesystem.prototype, "lookup").mockRejectedValueOnce(error);
  try {
    await expect(
      session.open({
        ...options,
        programs: {
          onDemand: [
            defineProgramPackage({
              name: "unavailable",
              programs: [
                { path: "/bin/unavailable", command: { load: async () => async () => 0 } },
              ],
            }),
          ],
        },
      }),
    ).rejects.toBe(error);
    expect(active().catalog).toEqual({ kind: "failed", error, programs: [] });
    expect(runtime().programs.status()).toEqual([]);
    await runtime().filesystem.writeFile("/still-working", "available");
    expect(new TextDecoder().decode(await runtime().filesystem.readFile("/still-working"))).toBe(
      "available",
    );
  } finally {
    probe.mockRestore();
  }
});

test("retained startup observers cannot publish into a replacement or revive a finished state", async () => {
  const states: string[] = [];
  const installed: RuntimeOptions[] = [];
  const create = sdk.createRuntime;
  const observe = spyOn(sdk, "createRuntime").mockImplementation((options) => {
    installed.push(options ?? {});
    return create(options);
  });
  try {
    await session.open({
      ...options,
      onStartupStage: (stage) => {
        states.push(stage);
      },
    });
    const old = installed[0]!;
    await session.open(options);
    const snapshot = session.snapshot();
    const count = states.length;
    old.onStartupStage?.("filesystem-connected", 1);
    old.filesystem?.onStateChange?.({ status: "failed", error: new Error("late failure") });
    expect(states).toHaveLength(count);
    expect(session.snapshot()).toEqual(snapshot);
  } finally {
    observe.mockRestore();
  }
});

test("failed package cleanup blocks replacement rather than proving physical stop", async () => {
  await session.close();
  const blocked = new ProgramSession();
  const error = new Error("payload cleanup failed");
  await blocked.open({
    ...options,
    programs: {
      onDemand: [
        {
          name: "cleanup",
          programs: [{ path: "/bin/cleanup", command: { load: async () => async () => 0 } }],
          dispose: async () => {
            throw error;
          },
        },
      ],
    },
  });
  const replacement = await rejection(blocked.open(options));
  expect(replacement).toBeInstanceOf(Error);
  expect(blocked.snapshot()).toEqual({ kind: "failed", error: replacement });
  expect(blocked.runtime()).toBeUndefined();
  expect(await rejection(blocked.open(options))).toBe(replacement);
  expect(await rejection(blocked.close())).toBe(replacement);
});
