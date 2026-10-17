import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildBrowserEntries } from "../../scripts/browser-build";
import { initialJavaScript } from "../../scripts/runtime-size";
import { runInNewContext } from "node:vm";
import { DescriptorTable, OpenDescription } from "../../runtime/core/descriptors";
import { FilesystemClient, FilesystemService, MemoryBackend, connectFilesystemIdentity, createFilesystemConnection, createProcessFilesystemIdentity, revokeFilesystem, sharedRevoked } from "../../runtime/fs";
import * as protocol from "../../runtime/fs/protocol";
import * as codec from "../../runtime/proc/filesystem-codec";
import * as client from "../../runtime/proc/worker-client";
import { claimOutcome, outcomeWord, readOutcome } from "../../runtime/proc/outcome";
import { SubprocessHost } from "../src/subprocess";
import type { RunRequest, WorkerMessage } from "../src/worker";

const source = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(
  readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, "")
    .replace(/import\("\.\.\/\.\.\/runtime\/proc\/worker-client"\)/g, 'loadRuntime("client")')
    .replace(/import\("\.\.\/\.\.\/runtime\/proc\/filesystem-codec"\)/g, 'loadRuntime("codec")')
    .replace(/import\("\.\.\/\.\.\/runtime\/fs\/protocol"\)/g, 'loadRuntime("protocol")'),
);

test("worker installs arbitrary file, dup and directory bindings before launch without reopening paths", async () => {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const rootConnection = createFilesystemConnection();
  service.connect(rootConnection.server);
  const fs = new FilesystemClient(rootConnection.client);
  const parent = new DescriptorTable();
  let workerTable: DescriptorTable | undefined;
  const transport = client.createWorkerProcessTransport();
  const messages: client.WorkerProcessMessage[] = [];
  try {
    await fs.asyncCall("writeFile", ["/inherited"], new TextEncoder().encode("abcdef"));
    const directory = await fs.asyncCall("preopen", ["/"]);
    const path = await fs.asyncCall("resolve", [directory, "inherited"]);
    fs.retain(path.node); fs.retain(directory);
    const file = { kind: "file" as const, handle: path.node, offset: 1, append: false };
    const fd = parent.open(file, 0x123n, 0n, () => fs.release(path.node));
    const dir = parent.open({ kind: "directory", handle: directory }, 0x456n, 0x789n, () => fs.release(directory));
    const process = new client.WorkerProcessClient({
      transport, descriptors: parent, codec: codec.createFilesystemDescriptorCodec(fs),
      postMessage(message) { messages.push(message); },
      prepareSpawn() {
        const end = fs.beginTransfer();
        const filesystem = createProcessFilesystemIdentity(fs.connection);
        return { data: { filesystem }, codec: codec.createFilesystemDescriptorCodec(fs, filesystem), commit: end, cancel: end };
      },
    });
    process.spawn(1, { executable: "fixture", argv: [], env: {}, cwd: "/", job: 1, fds: [
      { child: 17, parent: fd }, { child: 31, parent: fd }, { child: 42, parent: dir },
    ] });
    const child = messages[0]!.transport;
    expect(child.resources).toHaveLength(2);
    parent.dispose();
    await fs.asyncCall("removePath", [path, false]);
    service.sweep();
    expect(backend.shared.hasFile(path.node)).toBe(true);
    const identity = (child.data as { filesystem: protocol.FilesystemIdentity }).filesystem;
    const connection = connectFilesystemIdentity(identity);
    service.connect(connection.server);
    const sent: WorkerMessage[] = [];
    const context = {
      crossOriginIsolated: true, location: { href: "http://localhost/worker.js" },
      postMessage(message: WorkerMessage) { sent.push(message); },
      onmessage: undefined as unknown as (event: { data: RunRequest }) => Promise<void>,
    };
    const memory = new WebAssembly.Memory({ initial: 1 });
    let launched = false;
    runInNewContext(source, {
      self: context, performance, Response, TextEncoder, URL, console, Error,
      SharedArrayBuffer, Atomics, Int32Array, BigInt64Array,
      FilesystemClient, revokeFilesystem, sharedRevoked, SubprocessHost, claimOutcome, outcomeWord, readOutcome,
      loadRuntime: async (name: string) => ({ client, codec, protocol })[name as "client"],
      HOST_CALL_FD: 3,
      WebAssembly: { Memory: WebAssembly.Memory, Instance: class { exports = { memory, _start() {} }; } },
      WasiExit: class extends Error {},
      Wasi: class {
        descriptors = workerTable = new DescriptorTable();
        imports() { return {}; }
        launch() {
          launched = true;
          const first = this.descriptors.get(17)!;
          const duplicate = this.descriptors.get(31)!;
          const directory = this.descriptors.get(42)!;
          expect(first.description).toBe(duplicate.description);
          expect(first.rightsBase).toBe(0x123n);
          expect(directory.rightsInheriting).toBe(0x789n);
          expect(directory.resource.kind).toBe("directory");
          if (first.resource.kind !== "file") throw new Error("missing inherited file");
          expect(first.resource.offset).toBe(1);
          first.resource.offset = 4;
          expect(file.offset).toBe(4);
          return 0;
        }
      },
    });
    await context.onmessage({ data: {
      engine: "browser", adapter: "preview1", module: {} as WebAssembly.Module, args: [], env: {},
      filesystem: connection.client, runtimeProcess: child, trace: false, net: null, moduleCache: null,
    } });
    expect(launched).toBe(true);
    expect(sent.filter(message => message.type === "exit")).toEqual([{ type: "exit", code: 0, signal: undefined, sleep: "atomics" }]);
    expect(workerTable!.get(17)).toBeUndefined();
    await fs.asyncCall("listFiles", ["/"]);
    service.sweep();
    expect(backend.shared.hasFile(path.node)).toBe(false);
  } finally { workerTable?.dispose(); parent.dispose(); fs.dispose(); service.dispose(); }
});

test("ordinary Bun worker and page startup do not eagerly load generic ownership adapters", async () => {
  const base = process.env.RUNNER_TEMP ?? process.env.SCRATCH ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
  const scratch = await mkdtemp(join(base, "bun-wasm-runtime-ownership-"));
  try {
    const entry = new URL("../src/runner.ts", import.meta.url).pathname;
    const build = await buildBrowserEntries([entry, new URL("../src/worker.ts", import.meta.url).pathname], join(scratch, "dist"));
    const outputs = build.metafile!.outputs;
    const roots = Object.keys(outputs).filter(path => path.endsWith("/runner.js") || path.endsWith("/worker.js"));
    expect(roots).toHaveLength(2);
    const initial = initialJavaScript(outputs, roots);
    const inputs = initial.flatMap(path => Object.keys(outputs[path]!.inputs));
    for (const name of ["worker-client", "worker-broker", "filesystem-codec", "pipes", "abi"]) {
      expect(inputs.some(path => path.endsWith(`/runtime/proc/${name}.ts`))).toBe(false);
    }
    expect(Object.keys(build.metafile!.inputs).some(path => path.endsWith("/runtime/proc/worker-client.ts"))).toBe(true);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

for (const failure of ["client", "codec", "protocol", "binding"] as const) test(`generic worker startup catches ${failure} failures and releases initialized resources`, async () => {
  const transport = client.createWorkerProcessTransport();
  const connection = createFilesystemConnection();
  const filesystem = connection.client;
  const events: string[] = [];
  const sent: WorkerMessage[] = [];
  const context = {
    crossOriginIsolated: true, location: { href: "http://localhost/worker.js" },
    postMessage(message: WorkerMessage) { sent.push(message); },
    onmessage: undefined as unknown as (event: { data: RunRequest }) => Promise<void>,
  };
  let descriptors: DescriptorTable | undefined;
  let disposed = false;
  let launched = false;
  if (failure === "binding") {
    transport.bindings = [
      { fd: 17, reference: 0, rightsBase: 1n, rightsInheriting: 0n },
      { fd: 31, reference: 1, rightsBase: 1n, rightsInheriting: 0n },
    ];
    transport.resources = ["retained", "reject"];
  }
  const stream = { kind: "terminal" as const, read: () => 0, write: () => 0, readiness: () => ({ readable: false, writable: true, hangup: false }) };
  try {
    runInNewContext(source, {
      self: context, performance, Response, TextEncoder, URL, console, Error,
      SharedArrayBuffer, Atomics, Int32Array, BigInt64Array,
      FilesystemClient: class {
        connection = filesystem;
        dispose() { disposed = true; events.push("dispose fs"); }
      },
      revokeFilesystem, sharedRevoked, SubprocessHost, claimOutcome, outcomeWord, readOutcome,
      loadRuntime: async (name: string) => {
        if (name === failure) throw new Error(`startup ${failure} rejected`);
        if (name === "codec" && failure === "binding") return {
          createFilesystemDescriptorCodec: () => ({
            import(token: unknown) {
              if (token === "reject") throw new Error("startup binding rejected");
              return new OpenDescription(stream, () => events.push("dispose inherited"));
            },
            export() { throw new Error("unexpected export"); }, discard() {},
          }),
        };
        return ({ client, codec, protocol })[name as "client"];
      },
      HOST_CALL_FD: 3,
      WebAssembly: { Memory: WebAssembly.Memory, Instance: class { constructor() { throw new Error("must not instantiate"); } } },
      WasiExit: class extends Error {},
      Wasi: class {
        descriptors = descriptors = new DescriptorTable();
        constructor() { this.descriptors.open(stream, 1n, 0n, () => events.push("dispose default")); }
        imports() { return {}; }
        launch() { launched = true; return 0; }
      },
    });
    await expect(context.onmessage({ data: {
      engine: "browser", adapter: "preview1", module: {} as WebAssembly.Module, args: [], env: {},
      filesystem, runtimeProcess: transport, trace: false, net: null, moduleCache: null,
    } })).resolves.toBeUndefined();
    expect(launched).toBe(false);
    expect(disposed).toBe(true);
    const terminal = sent.filter(message => message.type === "error" || message.type === "exit");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ type: "error", code: 126 });
    if (terminal[0]?.type === "error") expect(terminal[0].message).toContain(`startup ${failure} rejected`);
    if (failure !== "binding") expect(events).toEqual(failure === "client" ? ["dispose fs"] : ["dispose default", "dispose fs"]);
    if (failure === "binding") {
      expect(events).toEqual(["dispose default", "dispose inherited", "dispose fs"]);
      expect(descriptors!.get(17)).toBeUndefined();
      expect(readOutcome(client.workerProcessState(transport).signals.outcome)).toMatchObject({ kind: "exited", code: 126 });
    }
  } finally { descriptors?.dispose(); filesystem.port.close(); connection.server.port.close(); }
});
