import { Wasi } from "../../core/wasi.js";
import { FilesystemClient, type FilesystemConnection } from "../../fs/index.js";

const decoder = new TextDecoder();

self.onmessage = ({
  data,
}: MessageEvent<{ connection: FilesystemConnection; module: WebAssembly.Module }>) => {
  const fs = new FilesystemClient(data.connection);
  const memory = new WebAssembly.Memory({ initial: 4, maximum: 256 });
  const output: string[] = [];
  const wasi = new Wasi({
    args: ["fixture"],
    env: {},
    fs,
    preopens: { "/": "/", "/tmp": "/tmp" },
    reservedFds: [3],
    namespaces: { env: { memory } },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  let reply: unknown;
  try {
    wasi.descriptors.openAt(
      3,
      {
        kind: "pipe",
        read: () => 0,
        write(chunks) {
          for (const chunk of chunks) output.push(decoder.decode(chunk));
          return chunks.reduce((n, chunk) => n + chunk.length, 0);
        },
        readiness: () => ({ readable: true, writable: true, hangup: false }),
      },
      (1n << 29n) - 1n,
      0n,
    );
    const instance = new WebAssembly.Instance(data.module, wasi.imports(data.module));
    const exit = wasi.start(instance);
    reply = { exit, output: output.join("") };
  } catch (error) {
    reply = {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    };
  } finally {
    wasi.descriptors.dispose();
    fs.dispose();
  }
  self.postMessage(reply);
};
