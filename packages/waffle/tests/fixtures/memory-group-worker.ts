import { bootstrap } from "../../browser/worker.js";
import { linkedWorkerHooks, type LinkedWorkerRequest } from "../../link/index.js";

// Generic bootstrap and Waffle's link loader, plus test imports: a checkpoint and the
// announcement of the member's command block.
const post = globalThis.postMessage.bind(globalThis);
globalThis.onmessage = ({ data }: MessageEvent<LinkedWorkerRequest>) => {
  void bootstrap(data, {
    ...linkedWorkerHooks(),
    namespaces: () => ({
      test: {
        checkpoint() {},
        ready: (command: number, pid: number) => post({ type: "group-ready", command, pid }),
      },
    }),
    run: (_context, exited) => exited ?? 0,
  });
};
