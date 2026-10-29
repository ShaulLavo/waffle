import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import {
  createRuntime,
  type GuestLauncher,
  type Runtime,
  type RuntimeSupervisor,
} from "../index.js";
import { installPrograms, ProgramConflictError, type ProgramPackage } from "../programs/index.js";
import { DescriptorTable, type Stream } from "../core/descriptors.js";
import { createRuntimeTerminalCodec } from "../browser/runtime-terminals.js";
import { createWorkerPipeCodec } from "../proc/worker-pipes.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import { wasiCat } from "./fixtures/wasi-cat.js";

const requests = new Map<string, number>();
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const { pathname } = new URL(request.url);
    requests.set(pathname, (requests.get(pathname) ?? 0) + 1);
    if (pathname === "/cat.wasm") return new Response(wasiCat());
    if (pathname === "/garbage.wasm") return new Response("not wasm");
    return new Response("missing", { status: 404 });
  },
});
afterAll(() => server.stop(true));
const asset = (name: string) => new URL(`/${name}`, server.url);
const fetches = () => Array.from(requests.values()).reduce((sum, count) => sum + count, 0);

const textutils: ProgramPackage = {
  name: "textutils",
  programs: [{ path: "/usr/bin/cat", aliases: ["/bin/cat"], wasm: asset("cat.wasm") }],
};
const extras: ProgramPackage = {
  name: "extras",
  programs: [
    { path: "/usr/bin/broken", wasm: asset("missing.wasm") },
    { path: "/usr/bin/garbage", wasm: asset("garbage.wasm") },
  ],
};

let runtime: Runtime;
let tables: DescriptorTable[];
let launches: { argv: string[]; env: Record<string, string>; cwd: string }[];
// The caller's launcher: Waffle's generic preview1 worker, recording what each launch receives.
const workerUrl = new URL("../browser/preview1-worker.ts", import.meta.url).href;
const launcher: GuestLauncher = (context, service) => {
  const { argv, env, cwd } = context.request;
  launches.push({ argv: argv.slice(), env: { ...env }, cwd });
  return service.launchWorker(context, {
    workerUrl,
    request: { module: context.module, args: argv, env, interruptible: context.interruptible },
  });
};
const options = { launcher };
beforeEach(() => {
  requests.clear();
  tables = [];
  launches = [];
  runtime = createRuntime({
    filesystem: { mode: "memory", workerURL: new URL("../browser/fs-worker.ts", import.meta.url) },
  });
});
afterEach(async () => {
  await runtime.dispose();
  for (const table of tables) table.dispose();
});

// Bun 1.4.4's expect(promise).rejects stalled on rejections that wait on filesystem workers.
function failure(pending: Promise<unknown>): Promise<() => void> {
  return pending.then(
    () => () => {},
    (error: unknown) => () => {
      throw error;
    },
  );
}

async function root() {
  const service = await runtime.processes();
  const transport = createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: runtime.identities.job(),
    identity: runtime.identities.buffer,
  });
  transport.data = { filesystem: runtime.filesystem.createIdentity() };
  const output: string[] = [];
  await service.adoptRuntimeRoot(transport, {
    output: (_fd, bytes) => output.push(new TextDecoder().decode(bytes)),
  });
  const notices: WorkerProcessMessage[] = [];
  // The root's own terminal at fd 1 and 2. Children get stdio only through explicit bindings;
  // the terminal codec transfers it, and child writes come back through the root's output.
  const descriptors = new DescriptorTable();
  tables.push(descriptors);
  const write = (chunks: readonly Uint8Array[]) => {
    for (const chunk of chunks) output.push(new TextDecoder().decode(chunk));
    return chunks.reduce((total, chunk) => total + chunk.length, 0);
  };
  const terminal: Stream = {
    kind: "terminal",
    read: () => 0,
    write,
    tryWrite: write,
    readiness: () => ({ readable: true, writable: true, hangup: false }),
  };
  descriptors.openAt(1, terminal, 64n, 0n);
  descriptors.inherit(2, descriptors.get(1)!);
  const codec = createRuntimeTerminalCodec({ descriptors, fallback: createWorkerPipeCodec() });
  const client = new WorkerProcessClient({
    transport,
    descriptors,
    codec,
    prepareSpawn: () => ({ data: { filesystem: runtime.filesystem.createIdentity() } }),
    postMessage: (message) => notices.push(message),
  });
  const supervisor: RuntimeSupervisor = await service.ready();
  const pid = transport.pid;
  return {
    output,
    /** The guest-facing access query a shell uses for `command -v`: metadata only. */
    async access(path: string): Promise<number> {
      const id = supervisor.accessStart(pid, path, "/");
      while (!supervisor.accessReady(pid, id)) await Bun.sleep(1);
      return supervisor.accessTake(pid, id);
    },
    async spawn(
      executable: string,
      argv: string[],
      env: Record<string, string> = {},
      fds = [
        { parent: 1, child: 1 },
        { parent: 2, child: 2 },
      ],
    ) {
      const child = client.spawn(pid, { executable, argv, env, cwd: "/", job: -1, fds });
      while (notices.length) await service.runtimeMessage(notices.shift()!, pid);
      await supervisor.start(child);
      return {
        pid: child,
        kill: () => service.kill(child, 9),
        exit: supervisor.waitForExit(pid, child).then(async (exit) => {
          client.wait(pid, child);
          while (notices.length) await service.runtimeMessage(notices.shift()!, pid);
          return exit;
        }),
      };
    },
    async exec(executable: string, argv: string[], env?: Record<string, string>) {
      return (await this.spawn(executable, argv, env)).exit;
    },
  };
}

test("install writes markers and registrations, and PATH lookup fetches nothing", async () => {
  const installation = await installPrograms(runtime, [textutils, extras], options);
  expect(installation.path).toEqual(["/usr/bin", "/bin"]);
  expect(installation.executables).toEqual([
    "/usr/bin/cat",
    "/bin/cat",
    "/usr/bin/broken",
    "/usr/bin/garbage",
  ]);
  expect(await runtime.filesystem.lookup("/bin/cat")).toMatchObject({ kind: "file" });
  const shell = await root();
  for (const directory of installation.path) expect(await shell.access(`${directory}/cat`)).toBe(0);
  expect(await shell.access("/usr/bin/broken")).toBe(0);
  expect(await shell.access("/usr/bin/nothing")).toBeLessThan(0);
  expect(fetches()).toBe(0);
});

test("first exec runs the real program; aliases and concurrent execs share one load", async () => {
  await installPrograms(runtime, [textutils], options);
  await runtime.filesystem.writeFile("/etc/motd", "hello from waffle\n");
  const shell = await root();
  const exits = await Promise.all([
    shell.exec("/usr/bin/cat", ["cat", "/etc/motd"]),
    shell.exec("/bin/cat", ["cat", "/etc/motd"]),
  ]);
  expect(exits).toMatchObject([
    { kind: "exited", code: 0 },
    { kind: "exited", code: 0 },
  ]);
  expect(shell.output.join("")).toBe("hello from waffle\n".repeat(2));
  expect(await shell.exec("/bin/cat", ["cat", "/etc/missing"])).toMatchObject({ code: 1 });
  expect(requests.get("/cat.wasm")).toBe(1);
}, 20_000);

test("a child spawned without stdio bindings has fd 1 closed", async () => {
  await installPrograms(runtime, [textutils], options);
  await runtime.filesystem.writeFile("/etc/motd", "hello from waffle\n");
  const shell = await root();
  // cat exits 1 when fd_write fails; with no binding fd 1 is closed (EBADF), not the root's output.
  const unbound = await shell.spawn("/usr/bin/cat", ["cat", "/etc/motd"], {}, []);
  expect(await unbound.exit).toMatchObject({ kind: "exited", code: 1 });
  expect(shell.output).toEqual([]);
  expect(await shell.exec("/usr/bin/cat", ["cat", "/etc/motd"])).toMatchObject({ code: 0 });
  expect(shell.output.join("")).toBe("hello from waffle\n");
}, 20_000);

test("a failed load fails that exec only and the next exec fetches again", async () => {
  await installPrograms(runtime, [extras, textutils], options);
  const shell = await root();
  const missing = { kind: "start-failed", error: "EIO" };
  expect(await shell.exec("/usr/bin/broken", ["broken"])).toMatchObject(missing);
  expect(await shell.exec("/usr/bin/broken", ["broken"])).toMatchObject(missing);
  expect(requests.get("/missing.wasm")).toBe(2);
  expect(await shell.exec("/usr/bin/garbage", ["garbage"])).toMatchObject({
    kind: "start-failed",
    error: "ENOEXEC",
  });
  expect(await shell.exec("/bin/cat", ["cat"])).toMatchObject({ kind: "exited", code: 2 });
  expect(requests.get("/garbage.wasm")).toBe(1);
}, 20_000);

test("two programs claiming one path fail before any change", async () => {
  const clash: ProgramPackage = {
    name: "clash",
    programs: [{ path: "/bin/cat", wasm: asset("cat.wasm") }],
  };
  expect(await failure(installPrograms(runtime, [textutils, clash], options))).toThrow(
    ProgramConflictError,
  );
  expect(await runtime.filesystem.lookup("/usr/bin")).toBeUndefined();
  await installPrograms(runtime, [textutils], options);
});

test("a taken path rolls back every registration and created marker", async () => {
  await runtime.filesystem.writeFile("/bin/cat", "user file\n");
  expect(await failure(installPrograms(runtime, [textutils], options))).toThrow(
    ProgramConflictError,
  );
  expect(await runtime.filesystem.lookup("/usr/bin/cat")).toBeUndefined();
  expect(new TextDecoder().decode(await runtime.filesystem.readFile("/bin/cat"))).toBe(
    "user file\n",
  );
  await runtime.filesystem.remove("/bin/cat");
  const installation = await installPrograms(runtime, [textutils], options);
  expect(await failure(installPrograms(runtime, [textutils], options))).toThrow(
    /already registered/,
  );
  expect(await runtime.filesystem.lookup("/bin/cat")).toMatchObject({ kind: "file" });
  await installation.dispose();
});

test("invalid paths change nothing", async () => {
  const relative: ProgramPackage = {
    name: "relative",
    programs: [{ path: "/usr/bin/ok", aliases: ["bin/cat"], wasm: asset("cat.wasm") }],
  };
  expect(await failure(installPrograms(runtime, [relative], options))).toThrow(TypeError);
  expect(await runtime.filesystem.lookup("/usr")).toBeUndefined();
  await installPrograms(runtime, [textutils], options);
});

test("dispose removes what it created, keeps reused markers, and is idempotent", async () => {
  const marker = "waffle program: textutils /usr/bin/cat\n";
  await runtime.filesystem.writeFile("/bin/cat", marker);
  const installation = await installPrograms(runtime, [textutils], options);
  const shell = await root();
  expect(await shell.access("/bin/cat")).toBe(0);
  const disposal = installation.dispose();
  expect(installation.dispose()).toBe(disposal);
  await disposal;
  expect(await runtime.filesystem.lookup("/usr/bin/cat")).toBeUndefined();
  expect(new TextDecoder().decode(await runtime.filesystem.readFile("/bin/cat"))).toBe(marker);
  expect(await shell.access("/bin/cat")).toBeLessThan(0);
  expect(fetches()).toBe(0);
  await installPrograms(runtime, [textutils], options);
});

test("runtime disposal during install rejects without leaving work behind", async () => {
  const pending = installPrograms(runtime, [textutils, extras], options);
  await runtime.dispose();
  expect(await failure(pending)).toThrow();
  expect(await failure(installPrograms(runtime, [textutils], options))).toThrow(/disposed/);
});

const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const settle = () => Bun.sleep(50);

test("a reinstall while disposing fails until cleanup ends, then keeps its markers", async () => {
  const first = await installPrograms(runtime, [textutils], options);
  const disposing = first.dispose();
  expect(await failure(installPrograms(runtime, [textutils], options))).toThrow(
    /already registered/,
  );
  await disposing;
  const second = await installPrograms(runtime, [textutils], options);
  expect(await runtime.filesystem.lookup("/usr/bin/cat")).toMatchObject({ kind: "file" });
  expect(await runtime.filesystem.lookup("/bin/cat")).toMatchObject({ kind: "file" });
  await second.dispose();
});

// Another writer replaces a marker after disposal decided to remove it, just before the
// remove reaches the real filesystem worker. The replacement must survive.
test("dispose never deletes a marker replaced while it runs", async () => {
  const replaced = new Set<string>();
  const filesystem = Object.create(runtime.filesystem, {
    remove: {
      value: async (...args: Parameters<Runtime["filesystem"]["remove"]>) => {
        const [path] = args;
        if (!replaced.has(path)) {
          replaced.add(path);
          await runtime.filesystem.writeFile(path, `replacement ${path}\n`);
        }
        return runtime.filesystem.remove(...args);
      },
    },
  });
  const gated: Runtime = Object.create(runtime, { filesystem: { value: filesystem } });
  const installation = await installPrograms(gated, [textutils], options);
  await installation.dispose();
  expect(Array.from(replaced).sort()).toEqual(["/bin/cat", "/usr/bin/cat"]);
  for (const path of replaced)
    expect(decode(await runtime.filesystem.readFile(path))).toBe(`replacement ${path}\n`);
});

// A package that prepares a payload before its first run, like CPython's standard library.
function preparedPackage(behaviour: { fail?: number; gate?: Promise<void>; loop?: boolean } = {}) {
  const state = { prepares: 0, disposals: 0, payloadAtDispose: false };
  let failures = behaviour.fail ?? 0;
  const pkg: ProgramPackage = {
    name: "prepared",
    programs: [
      {
        path: "/usr/bin/pcat",
        aliases: ["/bin/pcat"],
        argv0: "/opt/prepared/cat.wasm",
        source: async () => {
          state.prepares++;
          if (failures-- > 0) throw new Error("payload download failed");
          await behaviour.gate;
          await runtime.filesystem.writeFile("/opt/prepared/data.txt", "prepared\n");
          return behaviour.loop ? loop() : wasiCat();
        },
      },
    ],
    dispose: async () => {
      state.disposals++;
      state.payloadAtDispose =
        (await runtime.filesystem.lookup("/opt/prepared/data.txt")) !== undefined;
      await runtime.filesystem.remove("/opt/prepared/data.txt");
    },
  };
  return { pkg, state };
}
function loop(): Uint8Array {
  const header = [
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 19, 2, 6, 109,
    101, 109, 111, 114, 121, 2, 0, 6, 95, 115, 116, 97, 114, 116, 0, 0,
  ];
  return new Uint8Array(header.concat([10, 9, 1, 7, 0, 3, 64, 12, 0, 11, 11]));
}

test("a source loader prepares once on first exec and argv0 replaces only argv[0]", async () => {
  const { pkg, state } = preparedPackage();
  await installPrograms(runtime, [pkg, textutils], options);
  expect(state.prepares).toBe(0);
  expect(await runtime.filesystem.lookup("/opt/prepared/data.txt")).toBeUndefined();
  const shell = await root();
  const env = { TOKEN: "kept", PWD: "/" };
  const exits = await Promise.all([
    shell.exec("/usr/bin/pcat", ["pcat", "/opt/prepared/data.txt"], env),
    shell.exec("/bin/pcat", ["", "/opt/prepared/data.txt"], env),
  ]);
  expect(exits).toMatchObject([{ code: 0 }, { code: 0 }]);
  expect(shell.output.join("")).toBe("prepared\n".repeat(2));
  expect(state.prepares).toBe(1);
  expect(launches).toEqual([
    { argv: ["/opt/prepared/cat.wasm", "/opt/prepared/data.txt"], env, cwd: "/" },
    { argv: ["/opt/prepared/cat.wasm", "/opt/prepared/data.txt"], env, cwd: "/" },
  ]);
  expect(await shell.exec("/usr/bin/cat", ["cat", "/opt/prepared/data.txt"], env)).toMatchObject({
    code: 0,
  });
  expect(launches[2]).toEqual({ argv: ["cat", "/opt/prepared/data.txt"], env, cwd: "/" });
}, 20_000);

test("a failed prepare fails that exec only and the next exec prepares again", async () => {
  const { pkg, state } = preparedPackage({ fail: 1 });
  await installPrograms(runtime, [pkg], options);
  const shell = await root();
  const args = ["pcat", "/opt/prepared/data.txt"];
  expect(await shell.exec("/usr/bin/pcat", args)).toMatchObject({ kind: "start-failed" });
  expect(await shell.exec("/usr/bin/pcat", args)).toMatchObject({ kind: "exited", code: 0 });
  expect(state.prepares).toBe(2);
}, 20_000);

test("dispose keeps the payload until running processes physically stop", async () => {
  const { pkg, state } = preparedPackage({ loop: true });
  const installation = await installPrograms(runtime, [pkg], options);
  const shell = await root();
  const running = await shell.spawn("/usr/bin/pcat", ["pcat"]);
  while (!launches.length) await Bun.sleep(5);
  const disposal = installation.dispose();
  await settle();
  expect(state.disposals).toBe(0);
  expect(await runtime.filesystem.lookup("/usr/bin/pcat")).toBeUndefined();
  expect(await shell.access("/bin/pcat")).toBeLessThan(0);
  await running.kill();
  expect(await running.exit).toMatchObject({ kind: "signaled", code: 9 });
  await disposal;
  expect(state).toEqual({ prepares: 1, disposals: 1, payloadAtDispose: true });
  expect(await runtime.filesystem.lookup("/opt/prepared/data.txt")).toBeUndefined();
  expect(await installation.dispose()).toBeUndefined();
  expect(state.disposals).toBe(1);
}, 20_000);

test("dispose during an in-flight prepare waits for it, then refuses the launch", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { pkg, state } = preparedPackage({ gate });
  const installation = await installPrograms(runtime, [pkg], options);
  const shell = await root();
  const exit = shell.exec("/usr/bin/pcat", ["pcat", "/opt/prepared/data.txt"]);
  while (!state.prepares) await Bun.sleep(5);
  const disposal = installation.dispose();
  await settle();
  expect(state.disposals).toBe(0);
  release();
  expect(await exit).toMatchObject({ kind: "start-failed" });
  await disposal;
  expect(state.disposals).toBe(1);
  expect(launches).toEqual([]);
  expect(await runtime.filesystem.lookup("/opt/prepared/data.txt")).toBeUndefined();
}, 20_000);

test("a rolled-back install runs each package dispose hook once", async () => {
  const { pkg, state } = preparedPackage();
  await runtime.filesystem.writeFile("/bin/pcat", "user file\n");
  expect(await failure(installPrograms(runtime, [pkg], options))).toThrow(ProgramConflictError);
  expect(state).toEqual({ prepares: 0, disposals: 1, payloadAtDispose: false });
  expect(await runtime.filesystem.lookup("/usr/bin/pcat")).toBeUndefined();
});

test("program launch hooks receive the admitted real module and the installation fallback", async () => {
  let hookCalls = 0;
  let original: Parameters<GuestLauncher>[0] | undefined;
  const fallback: GuestLauncher = (context, service) => {
    if (!original) throw new Error("hook did not run");
    expect(context).toBe(original);
    return launcher(context, service);
  };
  const hooked: ProgramPackage = {
    name: "hooked",
    programs: [
      {
        path: "/bin/hooked",
        wasm: asset("cat.wasm"),
        launch(context, service, installationLauncher) {
          hookCalls++;
          original = context;
          expect(context.module).toBeInstanceOf(WebAssembly.Module);
          expect(installationLauncher).toBe(fallback);
          return installationLauncher(context, service);
        },
      },
    ],
  };
  const installed = await installPrograms(runtime, [hooked, textutils], { launcher: fallback });
  const process = await root();
  expect((await process.exec("/bin/hooked", ["custom", "/missing"], { PROOF: "same" })).code).toBe(
    1,
  );
  expect(hookCalls).toBe(1);
  expect(launches).toEqual([{ argv: ["custom", "/missing"], env: { PROOF: "same" }, cwd: "/" }]);
  await installed.dispose();
});
