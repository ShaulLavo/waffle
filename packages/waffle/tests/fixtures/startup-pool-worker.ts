import { bootstrap, type RuntimeWorkerRequest } from "../../browser/worker.js";

let runs = 0;
globalThis.onmessage = ({ data }: MessageEvent<RuntimeWorkerRequest>) => {
  void bootstrap(data, {
    instantiated({ instance, request, identity }) {
      const memory = instance.exports.memory;
      if (!(memory instanceof WebAssembly.Memory)) throw new Error("missing memory");
      const bytes = new Uint8Array(memory.buffer);
      globalThis.postMessage({
        type: "startup-pool-test",
        value: `${request.args[0]}|${request.env.TOKEN}|${++runs}|${bytes[0]}|${identity?.pid}`,
      });
      bytes[0] = 99;
      if (request.args[0] === "crash") throw new Error("injected startup failure");
    },
    run: (_context, exited) => exited ?? 0,
  });
};
