import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { createRuntime, type Runtime, type RuntimeSupervisor } from "../index.js";
import { installPrograms, ProgramConflictError, type ProgramPackage } from "../programs/index.js";
import { DescriptorTable } from "../core/descriptors.js";
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
beforeEach(() => {
  requests.clear();
  tables = [];
  runtime = createRuntime({
    filesystem: { mode: "memory", workerURL: new URL("../browser/fs-worker.ts", import.meta.url) },
  });
  const workerUrl = new URL("../browser/preview1-worker.ts", import.meta.url).href;
  runtime.registerAdapter("wasi", (context, service) =>
    service.launchWorker(context, {
      workerUrl,
      request: {
        module: context.module,
        args: context.request.argv,
        env: context.request.env,
        interruptible: context.interruptible,
      },
    }),
  );
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
  const descriptors = new DescriptorTable();
  tables.push(descriptors);
  const unused = (): never => {
    throw new Error("unexpected descriptor transfer");
  };
  const client = new WorkerProcessClient({
    transport,
    descriptors,
    codec: { export: unused, import: unused, discard() {} },
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
    async exec(executable: string, argv: string[]) {
      const child = client.spawn(pid, { executable, argv, env: {}, cwd: "/", job: -1, fds: [] });
      while (notices.length) await service.runtimeMessage(notices.shift()!, pid);
      await supervisor.start(child);
      const exit = await supervisor.waitForExit(pid, child);
      client.wait(pid, child);
      while (notices.length) await service.runtimeMessage(notices.shift()!, pid);
      return exit;
    },
  };
}

test("install writes markers and registrations, and PATH lookup fetches nothing", async () => {
  const installation = await installPrograms(runtime, [textutils, extras], { adapter: "wasi" });
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
  await installPrograms(runtime, [textutils], { adapter: "wasi" });
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

test("a failed load fails that exec only and the next exec fetches again", async () => {
  await installPrograms(runtime, [extras, textutils], { adapter: "wasi" });
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
  expect(await failure(installPrograms(runtime, [textutils, clash], { adapter: "wasi" }))).toThrow(
    ProgramConflictError,
  );
  expect(await runtime.filesystem.lookup("/usr/bin")).toBeUndefined();
  await installPrograms(runtime, [textutils], { adapter: "wasi" });
});

test("a taken path rolls back every registration and created marker", async () => {
  await runtime.filesystem.writeFile("/bin/cat", "user file\n");
  expect(await failure(installPrograms(runtime, [textutils], { adapter: "wasi" }))).toThrow(
    ProgramConflictError,
  );
  expect(await runtime.filesystem.lookup("/usr/bin/cat")).toBeUndefined();
  expect(new TextDecoder().decode(await runtime.filesystem.readFile("/bin/cat"))).toBe(
    "user file\n",
  );
  await runtime.filesystem.remove("/bin/cat");
  const installation = await installPrograms(runtime, [textutils], { adapter: "wasi" });
  expect(await failure(installPrograms(runtime, [textutils], { adapter: "wasi" }))).toThrow(
    /already registered/,
  );
  expect(await runtime.filesystem.lookup("/bin/cat")).toMatchObject({ kind: "file" });
  await installation.dispose();
});

test("unknown adapters and invalid paths change nothing", async () => {
  expect(await failure(installPrograms(runtime, [textutils], { adapter: "none" }))).toThrow(
    /Unknown adapter/,
  );
  const relative: ProgramPackage = {
    name: "relative",
    programs: [{ path: "/usr/bin/ok", aliases: ["bin/cat"], wasm: asset("cat.wasm") }],
  };
  expect(await failure(installPrograms(runtime, [relative], { adapter: "wasi" }))).toThrow(
    TypeError,
  );
  expect(await runtime.filesystem.lookup("/usr")).toBeUndefined();
  await installPrograms(runtime, [textutils], { adapter: "wasi" });
});

test("dispose removes what it created, keeps reused markers, and is idempotent", async () => {
  const marker = "waffle program: textutils /usr/bin/cat\n";
  await runtime.filesystem.writeFile("/bin/cat", marker);
  const installation = await installPrograms(runtime, [textutils], { adapter: "wasi" });
  const shell = await root();
  expect(await shell.access("/bin/cat")).toBe(0);
  const disposal = installation.dispose();
  expect(installation.dispose()).toBe(disposal);
  await disposal;
  expect(await runtime.filesystem.lookup("/usr/bin/cat")).toBeUndefined();
  expect(new TextDecoder().decode(await runtime.filesystem.readFile("/bin/cat"))).toBe(marker);
  expect(await shell.access("/bin/cat")).toBeLessThan(0);
  expect(fetches()).toBe(0);
  await installPrograms(runtime, [textutils], { adapter: "wasi" });
});

test("runtime disposal during install rejects without leaving work behind", async () => {
  const pending = installPrograms(runtime, [textutils, extras], { adapter: "wasi" });
  await runtime.dispose();
  expect(await failure(pending)).toThrow();
  expect(await failure(installPrograms(runtime, [textutils], { adapter: "wasi" }))).toThrow(
    /disposed/,
  );
});
