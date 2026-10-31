import { standaloneRuntimeProcess } from "./fixtures/standalone-runtime-process.js";
import { expect, test } from "bun:test";
import {
  bootstrap,
  type RuntimeWorkerMessage,
  type RuntimeWorkerRequest,
} from "../browser/worker.js";
import { createFilesystemConnection, FilesystemService, MemoryBackend } from "../fs/index.js";
import { DescriptorTable } from "../core/descriptors.js";
import { createWorkerProcessTransport } from "../proc/worker-client.js";
import { createFilesystemIdentity } from "../fs/protocol.js";

const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
const name = (value: string) => [value.length].concat(Array.from(new TextEncoder().encode(value)));
const inheritedFdModule = new WebAssembly.Module(
  new Uint8Array(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, [2, 0x60, 1, 0x7f, 1, 0x7f, 0x60, 0, 0]),
      section(2, [1].concat(name("runtime_proc"), name("inherited_fd"), [0, 0])),
      section(3, [1, 1]),
      section(5, [1, 0, 1]),
      section(7, [2].concat(name("memory"), [2, 0], name("_start"), [0, 1])),
      section(10, [1, 7, 0, 0x41, 0, 0x10, 0, 0x1a, 0x0b]),
    ),
  ),
);

test("runtime_proc.inherited_fd snapshots root stdio and excludes the preopen", async () => {
  const service = new FilesystemService(new MemoryBackend());
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const transport = createWorkerProcessTransport();
  transport.data = { filesystem: createFilesystemIdentity() };
  const descriptors = new DescriptorTable();
  let snapshot: number[] = [];
  const messages: RuntimeWorkerMessage[] = [];
  const request: RuntimeWorkerRequest = {
    controlGrant: { kind: "unbounded" },
    module: inheritedFdModule,
    args: [],
    env: {},
    filesystem: connection.client,
    runtimeProcess: standaloneRuntimeProcess(transport),
  };
  try {
    await bootstrap(
      request,
      {
        setup({ fs }) {
          fs.preopen = () => 1;
          fs.retain = () => {};
          fs.release = () => {};
        },
        instantiated({ wasi }) {
          const imported = wasi.imports(inheritedFdModule).runtime_proc?.inherited_fd;
          if (typeof imported !== "function") throw new Error("missing inherited_fd import");
          snapshot = [imported(0), imported(1), imported(2), imported(3)];
          wasi.descriptors.close(1);
          expect(imported(1)).toBe(1);
        },
        run() {
          return 0;
        },
      },
      {
        crossOriginIsolated: true,
        postMessage(message) {
          messages.push(message);
        },
      },
    );
    expect(snapshot).toEqual([0, 1, 2, -44]);
    expect(
      messages.some((message) => message.type === "runtime-proc" && message.operation === "exit"),
    ).toBe(true);
  } finally {
    descriptors.dispose();
    connection.client.port.close();
    connection.server.port.close();
    service.dispose();
  }
});
