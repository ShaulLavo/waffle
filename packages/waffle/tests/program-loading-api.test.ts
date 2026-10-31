import { testSharedMemory } from "./fixtures/shared-memory-platform.js";
import { afterEach, expect, spyOn, test } from "bun:test";
import { createRuntime, type Runtime, type RuntimeOptions, type GuestLauncher } from "../index.js";
import {
  defineProgramPackage,
  ProgramConflictError,
  type ProgramPackage,
} from "../programs/index.js";
import { DescriptorTable } from "../core/descriptors.js";
import { createProgramShell } from "./fixtures/program-shell.js";
import { waitStatus } from "../proc/wait-status.js";
import { wasiCat } from "./fixtures/wasi-cat.js";
import { SharedFilesystem } from "../browser/shared-fs.js";

let runtime: Runtime | undefined;
let tables: DescriptorTable[] = [];
let releases: Array<() => void> = [];
function create(options: Omit<RuntimeOptions, "sharedMemory"> = {}): Runtime {
  runtime = createRuntime({
    sharedMemory: testSharedMemory,
    filesystem: { mode: "memory", workerURL: new URL("../browser/fs-worker.ts", import.meta.url) },
    ...options,
  });
  return runtime;
}
afterEach(async () => {
  for (const release of releases) release();
  releases = [];
  await runtime?.dispose();
  runtime = undefined;
  for (const table of tables) table.dispose();
  tables = [];
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  releases.push(resolve);
  return { promise, resolve };
}
async function rejects(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => {
      throw new Error("expected failure");
    },
    (error: unknown) => error,
  );
}
function fixture(options: { gate?: Promise<void>; fail?: number } = {}) {
  let attempts = 0;
  let disposals = 0;
  let failures = options.fail ?? 0;
  const pkg = defineProgramPackage({
    name: "cat",
    programs: [
      {
        path: "/usr/bin/cat",
        aliases: ["/bin/cat"],
        source: async () => {
          attempts++;
          await options.gate;
          if (failures-- > 0) throw new Error("source unavailable");
          return wasiCat();
        },
      },
    ],
    dispose: async () => {
      disposals++;
    },
  });
  return { pkg, attempts: () => attempts, disposals: () => disposals };
}

test("unlisted programs are absent, fail 127, and never invoke sources", async () => {
  const program = fixture();
  const owner = create();
  await owner.programs.ready;
  expect(owner.programs.status()).toEqual([]);
  expect(await rejects(owner.programs.preload("cat"))).toBeInstanceOf(Error);
  const shell = await createProgramShell(owner, tables);
  const exit = await shell.exec("/usr/bin/cat", ["cat"]);
  expect(exit).toMatchObject({ kind: "start-failed", code: 2, error: "ENOENT" });
  expect(waitStatus(exit)).toBe(127);
  expect(program.attempts()).toBe(0);
  expect(await owner.filesystem.lookup("/bin/cat")).toBeUndefined();
});

test("startup onDemand installs metadata, exec loads once, and handles separate desired from actual state", async () => {
  const program = fixture();
  const owner = create({ programs: { onDemand: [program.pkg] } });
  await owner.programs.ready;
  const handle = owner.programs.get("cat")!;
  expect(handle.mode).toBe("onDemand");
  expect(handle.state).toEqual({ kind: "registered" });
  expect(Array.from(owner.programs)).toEqual([handle]);
  const seen: string[] = [];
  owner.programs.forEach((entry) => seen.push(entry.name));
  expect(seen).toEqual(["cat"]);
  expect(owner.programs.get("/bin/cat")).toBe(handle);
  const shell = await createProgramShell(owner, tables);
  expect(await shell.access("/bin/cat")).toBe(0);
  expect(program.attempts()).toBe(0);
  expect(await shell.exec("/bin/cat", ["cat"])).toMatchObject({ kind: "exited" });
  expect(handle.state).toEqual({ kind: "loaded" });
  expect(handle.mode).toBe("onDemand");
  await handle.preload();
  expect(handle.mode).toBe("preload");
  await owner.programs.onDemand(program.pkg);
  expect(handle.mode).toBe("onDemand");
  expect(handle.state.kind).toBe("loaded");
  expect(program.attempts()).toBe(1);
});

test("explicit preloads are awaitable and share in-flight fetch and compilation without activating processes", async () => {
  const gate = deferred();
  const program = fixture({ gate: gate.promise });
  let activations = 0;
  const owner = create({
    programs: { preload: [program.pkg] },
    processHost: () => {
      activations++;
      throw new Error("must not activate");
    },
  });
  let ready = false;
  void owner.programs.ready.then(() => {
    ready = true;
  });
  while (!program.attempts()) await Bun.sleep(1);
  const handle = owner.programs.get("cat")!;
  expect(handle.state.kind).toBe("preparing");
  const concurrent = Promise.all([
    owner.programs.preload("cat"),
    owner.programs.preload("/bin/cat"),
    handle.preload(),
  ]);
  expect(ready).toBe(false);
  gate.resolve();
  await concurrent;
  await owner.programs.ready;
  expect(handle.state.kind).toBe("loaded");
  expect(program.attempts()).toBe(1);
  expect(activations).toBe(0);
});

test("a package can be added and loaded after initialization; failed sources remain retryable", async () => {
  const program = fixture({ fail: 1 });
  const owner = create();
  await owner.programs.ready;
  expect(await rejects(owner.programs.preload(program.pkg))).toBeInstanceOf(Error);
  expect(owner.programs.get("cat")?.state.kind).toBe("error");
  await owner.programs.preload(program.pkg, "cat");
  expect(owner.programs.get("cat")?.state.kind).toBe("loaded");
  expect(program.attempts()).toBe(2);
  expect(owner.programs.status()).toHaveLength(1);
});

test("picks and aggregates preserve family identity, are idempotent, and dispose shared payload last", async () => {
  let disposed = 0;
  const family = defineProgramPackage({
    name: "family",
    programs: [
      { path: "/bin/one", source: async () => wasiCat() },
      { path: "/bin/two", source: async () => wasiCat() },
    ],
    dispose: async () => {
      disposed++;
    },
  });
  const aggregate = defineProgramPackage({
    name: "aggregate",
    programs: family.programs,
    packages: [family],
  });
  const owner = create();
  await owner.programs.onDemand(family.pick("one"), family.pick("one"));
  expect(owner.programs.status()).toHaveLength(1);
  await owner.programs.onDemand(aggregate);
  expect(owner.programs.status()).toHaveLength(2);
  expect(() => family.pick("missing")).toThrow("Unknown program");
  await owner.programs.get("one")!.remove();
  expect(disposed).toBe(0);
  await owner.programs.get("two")!.remove();
  expect(disposed).toBe(1);
});

test("conflicting paths and identities reject atomically before any new markers", async () => {
  const program = fixture();
  const owner = create();
  await owner.programs.onDemand(program.pkg);
  const conflict: ProgramPackage = {
    name: "other",
    programs: [{ path: "/bin/cat", source: async () => wasiCat() }],
  };
  const unrelated: ProgramPackage = {
    name: "new",
    programs: [{ path: "/bin/new", source: async () => wasiCat() }],
  };
  expect(await rejects(owner.programs.onDemand(unrelated, conflict))).toBeInstanceOf(
    ProgramConflictError,
  );
  expect(await owner.filesystem.lookup("/bin/new")).toBeUndefined();
  const changed: ProgramPackage = {
    ...program.pkg,
    programs: program.pkg.programs.map((entry) => ({ ...entry })),
  };
  expect(await rejects(owner.programs.onDemand(changed))).toBeInstanceOf(ProgramConflictError);
  expect(program.attempts()).toBe(0);
});

test("removing during loading fences preparation, prevents resurrection, and old handles cannot act on readds", async () => {
  const gate = deferred();
  const program = fixture({ gate: gate.promise });
  const owner = create();
  await owner.programs.onDemand(program.pkg);
  const old = owner.programs.get("cat")!;
  const loading = rejects(old.preload());
  while (!program.attempts()) await Bun.sleep(1);
  let removed = false;
  const removal = old.remove().then(() => {
    removed = true;
  });
  await Bun.sleep(10);
  expect(removed).toBe(false);
  expect(old.state.kind).toBe("removed");
  expect(await rejects(owner.programs.onDemand(program.pkg))).toBeInstanceOf(ProgramConflictError);
  gate.resolve();
  expect(await loading).toBeInstanceOf(Error);
  await removal;
  expect(program.disposals()).toBe(1);
  expect(await owner.filesystem.lookup("/bin/cat")).toBeUndefined();
  await owner.programs.onDemand(program.pkg);
  expect(owner.programs.get("cat")).not.toBe(old);
  expect(await rejects(old.preload())).toBeInstanceOf(Error);
  await old.remove();
  expect(await owner.filesystem.lookup("/bin/cat")).toBeDefined();
});

test("removal does not kill active consumers or release payload before physical stop", async () => {
  const program = fixture();
  const stopped = deferred();
  let context: Parameters<GuestLauncher>[0] | undefined;
  let terminations = 0;
  const owner = create({
    programs: {
      onDemand: [program.pkg],
      launcher: (guest) => {
        context = guest;
        guest.started();
        return {
          terminate: async () => {
            terminations++;
            await stopped.promise;
          },
        };
      },
    },
  });
  await owner.programs.ready;
  const shell = await createProgramShell(owner, tables);
  const running = await shell.spawn("/bin/cat", ["cat"]);
  let removed = false;
  const removal = owner.programs
    .get("cat")!
    .remove()
    .then(() => {
      removed = true;
    });
  await Bun.sleep(10);
  expect(terminations).toBe(0);
  expect(program.disposals()).toBe(0);
  expect(removed).toBe(false);
  context!.exit(0);
  while (!terminations) await Bun.sleep(1);
  expect(program.disposals()).toBe(0);
  stopped.resolve();
  expect(await running.exit).toMatchObject({ kind: "exited", code: 0 });
  await removal;
  expect(program.disposals()).toBe(1);
});

test("runtime disposal owns configured installations and a new runtime can reinstall", async () => {
  const program = fixture();
  const owner = create({ programs: { onDemand: [program.pkg] } });
  await owner.programs.ready;
  const old = owner.programs.get("cat")!;
  await owner.dispose();
  expect(old.state.kind).toBe("removed");
  expect(program.disposals()).toBe(1);
  expect(await rejects(old.preload())).toBeInstanceOf(Error);
  runtime = undefined;
  const next = create();
  await next.programs.preload(program.pkg);
  expect(next.programs.get("cat")?.state.kind).toBe("loaded");
});

test("a compile spy is a positive control for explicit preload", async () => {
  const compile = spyOn(WebAssembly, "compile");
  const unique = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 0, 4, 3, 97, 112, 105]);
  const pkg: ProgramPackage = {
    name: "control",
    programs: [{ path: "/bin/control", source: async () => unique }],
  };
  try {
    const owner = create();
    await owner.programs.preload(pkg);
    expect(compile.mock.calls.length).toBeGreaterThan(0);
  } finally {
    compile.mockRestore();
  }
});

test("a failed configured preload can be retried without poisoning process activation", async () => {
  const program = fixture({ fail: 1 });
  const owner = create({ programs: { preload: [program.pkg] } });
  expect(await rejects(owner.programs.ready)).toBeInstanceOf(Error);
  await owner.programs.preload("cat");
  const shell = await createProgramShell(owner, tables);
  expect(await shell.exec("/bin/cat", ["cat"])).toMatchObject({ kind: "exited" });
  expect(program.attempts()).toBe(2);
});

test("package identities conflict even when their program paths do not overlap", async () => {
  const first = defineProgramPackage({
    name: "same",
    programs: [{ path: "/bin/first", source: async () => wasiCat() }],
  });
  const second = defineProgramPackage({
    name: "same",
    programs: [{ path: "/bin/second", source: async () => wasiCat() }],
  });
  const owner = create();
  expect(await rejects(owner.programs.onDemand(first, second))).toBeInstanceOf(
    ProgramConflictError,
  );
  expect(owner.programs.status()).toEqual([]);
  expect(await owner.filesystem.lookup("/bin/first")).toBeUndefined();
});

test("a package disposing its last payload keeps its identity reserved", async () => {
  const gate = deferred();
  let disposing = false;
  const pkg = defineProgramPackage({
    name: "shared",
    programs: [
      { path: "/bin/first", source: async () => wasiCat() },
      { path: "/bin/second", source: async () => wasiCat() },
    ],
    dispose: async () => {
      disposing = true;
      await gate.promise;
    },
  });
  const owner = create();
  await owner.programs.onDemand(pkg.pick("first"));
  const removal = owner.programs.get("first")!.remove();
  while (!disposing) await Bun.sleep(1);
  expect(await rejects(owner.programs.onDemand(pkg.pick("second")))).toBeInstanceOf(
    ProgramConflictError,
  );
  gate.resolve();
  await removal;
  await owner.programs.onDemand(pkg.pick("second"));
});

test("URL package payloads are fetched once across preload and first execution", async () => {
  const fetching = spyOn(globalThis, "fetch").mockResolvedValue(new Response(wasiCat()));
  try {
    const pkg = defineProgramPackage({
      name: "fetched",
      programs: [
        {
          path: "/bin/fetched",
          aliases: ["/usr/bin/fetched"],
          wasm: new URL("https://example.test/cat.wasm"),
        },
      ],
    });
    const owner = create();
    await owner.programs.onDemand(pkg);
    const shell = await createProgramShell(owner, tables);
    await Promise.all([owner.programs.preload("fetched"), shell.exec("/usr/bin/fetched", ["cat"])]);
    expect(fetching.mock.calls).toHaveLength(1);
  } finally {
    fetching.mockRestore();
  }
});

test("runtime disposal during preparation cannot publish a loaded handle or resurrect an installation", async () => {
  const gate = deferred();
  const program = fixture({ gate: gate.promise });
  const owner = create({ programs: { preload: [program.pkg] } });
  const ready = rejects(owner.programs.ready);
  while (!program.attempts()) await Bun.sleep(1);
  const handle = owner.programs.get("cat")!;
  const disposal = owner.dispose();
  gate.resolve();
  expect(await ready).toBeInstanceOf(Error);
  await disposal;
  expect(handle.state.kind).toBe("removed");
  expect(program.disposals()).toBe(1);
});

test("catalog ownership survives copied metadata between source and prepared entrypoints", async () => {
  const original = fixture();
  const copied = defineProgramPackage({ ...original.pkg });
  const owner = create();
  await owner.programs.onDemand(original.pkg.pick("cat"));
  await owner.programs.onDemand(copied.pick("cat"));
  expect(owner.programs.status()).toHaveLength(1);
  expect(original.attempts()).toBe(0);
  await owner.programs.get("cat")!.remove();
  expect(original.disposals()).toBe(1);
});

test("the actual prepared runtime executes through its default prepared preview1 worker", async () => {
  const prepared: typeof import("../index.js") = await import(
    new URL("../dist/index.js", import.meta.url).href
  );
  const program = fixture();
  const owner = prepared.createRuntime({
    sharedMemory: testSharedMemory,
    filesystem: {
      mode: "memory",
      workerURL: new URL("../dist/browser/fs-worker.js", import.meta.url),
    },
    programs: { onDemand: [program.pkg] },
  });
  runtime = owner;
  await owner.programs.ready;
  await owner.filesystem.writeFile("/prepared-input", "prepared default worker\n");
  const shell = await createProgramShell(owner, tables);
  expect(await shell.exec("/bin/cat", ["cat", "/prepared-input"])).toMatchObject({
    kind: "exited",
    code: 0,
  });
  expect(shell.output.join("")).toBe("prepared default worker\n");
  expect(program.attempts()).toBe(1);
  expect(owner.programs.get("cat")?.state.kind).toBe("loaded");
});

test("removal closes executable admission while an alias marker is still installing", async () => {
  const aliasStarted = deferred();
  const aliasWrite = deferred();
  const program = fixture();
  let launches = 0;
  const owner = create({
    programs: {
      launcher(context) {
        launches++;
        context.started();
        context.exit(0);
        return { terminate() {} };
      },
    },
  });
  const shell = await createProgramShell(owner, tables);
  const original = SharedFilesystem.prototype.writeFile;
  const writing = spyOn(SharedFilesystem.prototype, "writeFile").mockImplementation(async function (
    this: SharedFilesystem,
    path,
    bytes,
    mode,
  ) {
    if (path === "/bin/cat") {
      aliasStarted.resolve();
      await aliasWrite.promise;
    }
    return original.call(this, path, bytes, mode);
  });
  const addition = owner.programs.onDemand(program.pkg);
  let removal: Promise<void> | undefined;
  try {
    await aliasStarted.promise;
    const handle = owner.programs.get("cat")!;
    removal = handle.remove();
    expect(handle.state.kind).toBe("removed");
    expect((await shell.exec("/usr/bin/cat", ["cat"])).kind).toBe("start-failed");
    expect(program.attempts()).toBe(0);
    expect(launches).toBe(0);
  } finally {
    aliasWrite.resolve();
    await addition;
    await removal;
    writing.mockRestore();
  }
  expect(await owner.filesystem.lookup("/usr/bin/cat")).toBeUndefined();
  expect(await owner.filesystem.lookup("/bin/cat")).toBeUndefined();
  expect(program.disposals()).toBe(1);
});
