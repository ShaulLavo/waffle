import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Wasi } from "../core/wasi.ts";
import { DescriptorTable, type Stream } from "../core/descriptors.ts";
import { MemFS } from "../fs/memory.ts";
import { bootstrap, type RuntimeWorkerMessage } from "../browser/worker.ts";
import { createFilesystemConnection } from "../fs/protocol.ts";
import { createWorkerProcessTransport } from "../proc/worker-client.ts";
import { ProcessABI } from "../proc/abi.ts";
import { ProcessSupervisor } from "../proc/supervisor.ts";
import { ExecutableRegistry } from "../proc/registry.ts";
import { pipeWriteRights } from "./fixtures/pipe-filestat-guest.ts";

const fixtures = process.env.WAFFLE_LIBC_FIXTURES;
const all = (1n << 29n) - 1n;
const decoder = new TextDecoder();
const layouts = [[], [3], [3, 4, 5, 6, 7, 8, 9], [5], [3, 10, 11, 12], [3, 1_000_000]];
async function guest(flavor: "patched" | "stock", start = false): Promise<WebAssembly.Module> {
  return new WebAssembly.Module(
    await Bun.file(join(fixtures!, `${flavor}${start ? "-start" : ""}.wasm`)).arrayBuffer(),
  );
}
function sink(output: string[]): Stream {
  return {
    kind: "pipe",
    read: () => 0,
    write(chunks) {
      for (const chunk of chunks) output.push(decoder.decode(chunk));
      return chunks.reduce((n, chunk) => n + chunk.length, 0);
    },
    readiness: () => ({ readable: true, writable: true, hangup: false }),
  };
}

function readPipeToEnd(stream: Stream): string {
  const output = new Uint8Array(32);
  let text = "";
  for (;;) {
    const length = stream.read([output]);
    if (length === 0) return text;
    text += decoder.decode(output.subarray(0, length));
  }
}

describe.skipIf(!fixtures)("real wasi-sdk 34 libc preopen discovery (bun run test:libc)", () => {
  for (const start of [false, true])
    for (const reserved of layouts)
      test(`patched libc layout ${reserved.join(",") || "ordinary"}, start=${start}`, async () => {
        const fs = new MemFS();
        fs.writeFile("/fixture", "fixture");
        const output: string[] = [],
          probes: number[] = [];
        let retained = 0,
          released = 0;
        fs.retain = () => {
          retained++;
        };
        fs.release = () => {
          released++;
        };
        const memory = new WebAssembly.Memory({ initial: 4, maximum: 256 });
        const wasi = new Wasi({
          args: ["fixture"],
          env: {},
          fs,
          preopens: { "/": "/", "/tmp": "/tmp" },
          reservedFds: reserved,
          namespaces: { env: { memory } },
          stdout() {},
          stderr() {},
          sleep() {},
          trace(line) {
            const match = /^fd_prestat_get\((\d+),/.exec(line);
            if (match) probes.push(Number(match[1]));
          },
        });
        const parents = new DescriptorTable();
        try {
          const fd = parents.open(sink(output), all, 123n);
          for (const target of reserved) wasi.descriptors.inherit(target, parents.get(fd)!);
          parents.close(fd); // The child must own its pin before the parent closes.
          let root = 3;
          while (reserved.includes(root)) root++;
          const rootEntry = wasi.descriptors.get(root)!;
          expect(rootEntry.preopen).toBe("/");
          expect(rootEntry.rightsBase).toBe(all);
          expect(rootEntry.rightsInheriting).toBe(all);
          expect(released).toBe(0);
          const module = await guest("patched", start);
          const instance = new WebAssembly.Instance(module, wasi.imports(module));
          expect(wasi.start(instance)).toBe(0);
          expect(output.join("")).toBe(reserved.includes(3) ? "early\nmain\n" : "");
          expect(Math.max(...probes)).toBeLessThanOrEqual(12);
          expect(probes).not.toContain(1_000_000);
          expect(rootEntry.description.references).toBe(1);
          expect(wasi.descriptors.get(root)).toBe(rootEntry);
          expect(retained - released).toBe(2); // Only the two preopens remain.
        } finally {
          parents.dispose();
          wasi.descriptors.dispose();
        }
        expect(retained).toBe(released);
      });

  for (const start of [false, true])
    test(`libc fstat accepts an ABI-created inherited pipe, start=${start}`, async () => {
      const fs = new MemFS();
      fs.writeFile("/fixture", "fixture");
      const parents = new DescriptorTable();
      const supervisor = new ProcessSupervisor({
        registry: new ExecutableRegistry(),
        launch() {
          throw new Error("not started");
        },
      });
      const wasi = new Wasi({
        args: ["fixture"],
        env: {},
        fs,
        preopens: { "/": "/" },
        reservedFds: [3],
        namespaces: { env: { memory: new WebAssembly.Memory({ initial: 4, maximum: 256 }) } },
        stdout() {},
        stderr() {},
        sleep() {},
      });
      try {
        const memory = new WebAssembly.Memory({ initial: 1 });
        const pid = supervisor.createRoot({ descriptors: parents });
        const abi = new ProcessABI({
          memory,
          descriptors: parents,
          fs,
          pid,
          service: supervisor,
          signals: supervisor.get(pid)!,
        });
        expect(abi.imports.pipe!(32)).toBe(0);
        const view = new DataView(memory.buffer);
        const reader = view.getUint32(32, true),
          writer = view.getUint32(36, true);
        wasi.descriptors.inherit(3, parents.get(writer)!);
        parents.close(writer);
        const module = await guest("patched", start);
        const instance = new WebAssembly.Instance(module, wasi.imports(module));
        expect(wasi.start(instance)).toBe(0);
        expect(wasi.descriptors.get(3)!.rightsBase).toBe(pipeWriteRights);
        expect(wasi.descriptors.get(3)!.rightsInheriting).toBe(0n);
        wasi.descriptors.close(3);
        expect(readPipeToEnd(parents.get(reader)!.resource as Stream)).toBe("early\nmain\n");
      } finally {
        wasi.descriptors.dispose();
        supervisor.dispose();
        parents.dispose();
      }
    });

  test("unchanged third-party libc works ordinarily but cannot discover root behind inherited fd3", async () => {
    for (const reserved of [[], [3]]) {
      const fs = new MemFS();
      fs.writeFile("/fixture", "fixture");
      const wasi = new Wasi({
        args: ["fixture"],
        env: {},
        fs,
        preopens: { "/": "/" },
        reservedFds: reserved,
        stdout() {},
        stderr() {},
        sleep() {},
      });
      try {
        if (reserved.length) wasi.descriptors.openAt(3, sink([]), all, all);
        const module = await guest("stock");
        const instance = new WebAssembly.Instance(module, wasi.imports(module));
        expect(wasi.start(instance)).toBe(reserved.length ? 41 : 0);
      } finally {
        wasi.descriptors.dispose();
      }
    }
  });

  test("libc propagates real fdstat errors instead of treating them as gaps", async () => {
    const wasi = new Wasi({
      args: ["fixture"],
      env: {},
      fs: new MemFS(),
      preopens: { "/": "/" },
      reservedFds: [3],
      stdout() {},
      stderr() {},
      sleep() {},
    });
    try {
      const module = await guest("patched");
      const imports = wasi.imports(module);
      imports.wasi_snapshot_preview1!.fd_fdstat_get = () => 29; // EIO, not BADF.
      expect(wasi.start(new WebAssembly.Instance(module, imports))).toBe(71);
    } finally {
      wasi.descriptors.dispose();
    }
  });

  test("generic worker installs exact inherited fd3 and preserves root before a real Wasm start section", async () => {
    const fs = new MemFS();
    fs.writeFile("/fixture", "fixture");
    const connection = createFilesystemConnection(),
      runtimeProcess = createWorkerProcessTransport();
    runtimeProcess.resources.push({ kind: "web-terminal", target: 1 });
    runtimeProcess.bindings.push({ fd: 3, reference: 0, rightsBase: all, rightsInheriting: 123n });
    const messages: RuntimeWorkerMessage[] = [],
      output: string[] = [];
    let retained = 0,
      released = 0;
    try {
      await bootstrap(
        {
          module: await guest("patched", true),
          args: ["fixture"],
          env: {},
          filesystem: connection.client,
          runtimeProcess,
        },
        {
          setup({ fs: client }) {
            for (const name of ["preopen", "resolve", "stat", "read", "write", "resize"] as const)
              Object.assign(client, { [name]: fs[name].bind(fs) });
            client.retain = () => {
              retained++;
            };
            client.release = () => {
              released++;
            };
          },
          namespaces: () => ({
            env: { memory: new WebAssembly.Memory({ initial: 4, maximum: 256 }) },
          }),
          resolveTerminal: () => sink(output),
          beforeBindings({ wasi }) {
            expect(wasi.descriptors.get(4)?.preopen).toBe("/");
            expect(released).toBe(0);
          },
          instantiated({ wasi }) {
            expect(output.join("")).toBe("early\n");
            expect(wasi.descriptors.get(3)?.rightsInheriting).toBe(123n);
            expect(wasi.descriptors.get(3)?.preopen).toBeUndefined();
            expect(wasi.descriptors.get(4)?.preopen).toBe("/");
            expect(retained - released).toBe(1);
          },
          run: (_context, exited) => exited ?? 0,
        },
        {
          crossOriginIsolated: true,
          postMessage(message) {
            messages.push(message);
          },
        },
      );
      expect(
        messages.filter((message) => message.type === "exit" || message.type === "error"),
      ).toMatchObject([{ type: "exit", code: 0 }]);
      expect(output.join("")).toBe("early\nmain\n");
      expect(retained).toBe(released);
    } finally {
      connection.client.port.close();
      connection.server.port.close();
    }
  });
});
