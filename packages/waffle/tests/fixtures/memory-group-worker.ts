import { bootstrap, type RuntimeWorkerRequest } from "../../browser/worker.js";

// Generic bootstrap plus one test import that announces the member's command block.
const post = globalThis.postMessage.bind(globalThis);
globalThis.onmessage = ({ data }: MessageEvent<RuntimeWorkerRequest>) => {
  void bootstrap(data, {
    namespaces: () => ({
      test: {
        ready: (command: number, pid: number) => post({ type: "group-ready", command, pid }),
      },
    }),
    run: (_context, exited) => exited ?? 0,
  });
};
