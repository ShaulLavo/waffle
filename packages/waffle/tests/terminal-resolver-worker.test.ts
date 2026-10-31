import { standaloneRuntimeProcess } from "./fixtures/standalone-runtime-process.js";
import { expect, test } from "bun:test";
import { Worker, MessagePort as NodeMessagePort } from "node:worker_threads";
import {
  claimTerminalAuthority,
  createTerminalInput,
  createTerminalInputPolicy,
  createTerminalSession,
  type TerminalResult,
} from "../browser/runtime-terminals.js";
import type { RuntimeWorkerMessage } from "../browser/worker.js";
import { createFilesystemConnection } from "../fs/protocol.js";
import { PipeController } from "../proc/pipes.js";
import { createWorkerProcessTransport } from "../proc/worker-client.js";
import type {
  TerminalResolverRequest,
  TerminalResolverResult,
} from "./fixtures/terminal-resolver-worker.js";

const module = new WebAssembly.Module(
  new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 19, 2, 6, 109,
    101, 109, 111, 114, 121, 2, 0, 6, 95, 115, 116, 97, 114, 116, 0, 0, 10, 4, 1, 2, 0, 11,
  ]),
);
function must<T>(result: TerminalResult<T>): T {
  if (result.kind === "error") throw Error(result.code);
  return result.value;
}

for (const mode of ["input", "none", "pipe"] as const)
  test(`real Worker stdin-only resolution preserves host output with ${mode}`, async () => {
    const transport = createWorkerProcessTransport();
    const connection = createFilesystemConnection();
    const input = createTerminalInput({ capacity: 64 });
    const display = createTerminalSession({
      controller: transport,
      geometry: { columns: 80, rows: 24 },
    });
    const pipe = new PipeController({ capacity: 64, relay: "manual" });
    const reader = pipe.retain(transport.pid, "read");
    const writer = pipe.retain(transport.pid + 1, "write");
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const policy = createTerminalInputPolicy({ input });
      const authority = must(
        claimTerminalAuthority({
          identity: display.identity,
          process: transport,
          checkActive() {},
          policy,
        }),
      );
      const group = must(authority.createGroup({ initialMode: "raw" }));
      must(authority.admitExisting({ group, pid: transport.pid }));
      must(authority.acquire({ group, expected: null }));
      if (mode === "input") {
        transport.data = { terminalContext: display.inherit(), terminalInput: input.buffer };
        expect(input.push(new TextEncoder().encode("input"))).toBe(5);
      }
      transport.resources = [0, 1, 2].map((target) => ({ kind: "web-terminal", target }));
      if (mode === "pipe") {
        transport.resources[0] = { kind: "pipe", endpoint: reader.handle() };
        expect(writer.tryWrite([new TextEncoder().encode("pipe")])).toBe(4);
        writer.close();
      }
      transport.bindings = [0, 1, 2].map((fd) => ({
        fd,
        reference: fd,
        rightsBase: (1n << 29n) - 1n,
        rightsInheriting: 0n,
      }));
      const request: TerminalResolverRequest = {
        controlGrant: { kind: "unbounded" },
        module,
        args: [],
        env: {},
        filesystem: connection.client,
        runtimeProcess: standaloneRuntimeProcess(transport),
      };
      if (!(connection.client.port instanceof NodeMessagePort))
        throw Error("expected native worker port");
      worker = new Worker(new URL("./fixtures/terminal-resolver-worker.ts", import.meta.url), {
        workerData: request,
        transferList: [connection.client.port],
      });
      const messages: (RuntimeWorkerMessage | TerminalResolverResult)[] = [];
      const exited = new Promise<void>((resolve, reject) => {
        worker!.on("message", (message: RuntimeWorkerMessage | TerminalResolverResult) =>
          messages.push(message),
        );
        worker!.on("error", reject);
        worker!.on("exit", (code) =>
          code === 0 ? resolve() : reject(Error(`worker exited ${code}`)),
        );
        timer = setTimeout(() => reject(Error("terminal resolver worker timeout")), 5000);
      });
      await exited;
      expect(messages.filter((m) => m.type === "stdout")).toEqual([
        { type: "stdout", data: new TextEncoder().encode("out") },
      ]);
      expect(messages.filter((m) => m.type === "stderr")).toEqual([
        { type: "stderr", data: new TextEncoder().encode("err") },
      ]);
      expect(messages.filter((m) => m.type === "exit")).toMatchObject([{ code: 0 }]);
      expect(messages.find((m) => m.type === "resolver-result")).toEqual({
        type: "resolver-result",
        input: mode === "none" ? "" : mode,
        stdout: true,
        stderr: true,
        policyWrite: mode === "input" ? -58 : undefined,
        revoked: true,
      });
    } finally {
      clearTimeout(timer);
      await worker?.terminate();
      connection.client.port.close();
      connection.server.port.close();
      reader.close();
      writer.close();
      pipe.dispose();
      display.close("disposed");
    }
  });
