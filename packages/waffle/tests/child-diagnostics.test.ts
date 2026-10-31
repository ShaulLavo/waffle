import { standaloneRuntimeProcess } from "./fixtures/standalone-runtime-process.js";
import { expect, test } from "bun:test";
import { browserRuntimeDiagnostic, diagnosticDeadline } from "./child-diagnostic-browser.js";
import { bootstrap, type RuntimeWorkerMessage } from "../browser/worker.js";
import { createFilesystemConnection } from "../fs/index.js";
import { createWorkerProcessTransport } from "../proc/worker-client.js";

const module = new WebAssembly.Module(
  new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 19, 2, 6, 109,
    101, 109, 111, 114, 121, 2, 0, 6, 95, 115, 116, 97, 114, 116, 0, 0, 10, 4, 1, 2, 0, 11,
  ]),
);

test("generic child error writes the complete diagnostic before closing inherited stderr", async () => {
  const connection = createFilesystemConnection();
  const runtimeProcess = createWorkerProcessTransport();
  runtimeProcess.resources.push({ kind: "web-terminal", target: 2 });
  runtimeProcess.bindings.push({ fd: 2, reference: 0, rightsBase: 1n << 6n, rightsInheriting: 0n });
  const chunks: Uint8Array[] = [],
    order: string[] = [],
    messages: RuntimeWorkerMessage[] = [];
  const diagnostic = "child diagnostic " + "x".repeat(4096);
  const error = new Error(diagnostic);
  error.stack = "";
  try {
    await bootstrap(
      {
        controlGrant: { kind: "unbounded" },
        module,
        args: [],
        env: {},
        filesystem: connection.client,
        runtimeProcess: standaloneRuntimeProcess(runtimeProcess),
      },
      {
        setup({ fs }) {
          fs.preopen = () => 1;
          fs.retain = () => {};
          fs.release = () => {};
        },
        resolveTerminal: () => ({
          kind: "terminal",
          read: () => 0,
          write() {
            throw new Error("runtime diagnostics must never enter a blocking write");
          },
          tryWrite(data) {
            order.push("write");
            const part = data[0]!.slice(0, 7);
            chunks.push(part);
            return part.length;
          },
          close() {
            order.push("close");
          },
          readiness: () => ({ readable: false, writable: true, hangup: false }),
        }),
        run() {
          throw error;
        },
      },
      {
        crossOriginIsolated: true,
        postMessage(message) {
          messages.push(message);
          if (message.type === "error") order.push("error");
        },
      },
    );
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe(`Error: ${diagnostic}\n`);
    expect(order.filter((event) => event === "close")).toHaveLength(1);
    expect(order.slice(-2)).toEqual(["close", "error"]);
    expect(messages.filter((message) => message.type === "error")).toHaveLength(1);
  } finally {
    connection.client.port.close();
    connection.server.port.close();
  }
});

test("browser diagnostic deadline covers EOF after acknowledgement and permits teardown", async () => {
  const ack = Promise.resolve("acknowledged"),
    eof = Promise.withResolvers<void>();
  let cleaned = false;
  const operation = (async () => {
    try {
      await diagnosticDeadline(Promise.all([ack, eof.promise]), "acknowledgement and EOF", 5);
    } finally {
      cleaned = true;
      eof.resolve();
    }
  })();
  await expect(operation).rejects.toThrow("acknowledgement and EOF timeout");
  expect(cleaned).toBe(true);
});

test("browser stalled-tail deadline covers an EOF that never arrives", async () => {
  const eof = Promise.withResolvers<void>();
  try {
    await expect(diagnosticDeadline(eof.promise, "stalled EOF", 5)).rejects.toThrow(
      "stalled EOF timeout",
    );
  } finally {
    eof.resolve();
  }
});

for (const mode of ["draining", "slow", "stalled", "closed"] as const)
  test(`real child diagnostic pipe with ${mode} reader releases before acknowledgement`, async () => {
    await browserRuntimeDiagnostic(
      new URL("./child-diagnostic-worker.ts", import.meta.url).href,
      mode,
    );
  }, 15_000);
