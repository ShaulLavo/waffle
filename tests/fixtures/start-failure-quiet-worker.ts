import { bootstrap, type RuntimeWorkerRequest } from "../../browser/worker.js";

export interface QuietFailureRequest extends RuntimeWorkerRequest {
  stage: "missing-start" | "adapter-entry" | "parent";
}

declare const self: {
  onmessage: (event: MessageEvent<QuietFailureRequest>) => void;
  postMessage(message: unknown): void;
};

self.onmessage = ({ data }) => {
  void bootstrap(data, {
    setup({ fs }) {
      fs.preopen = () => 1;
      fs.retain = () => {};
      fs.release = () => {};
    },
    instantiated() {
      if (data.stage === "adapter-entry") throw new Error("quiet adapter entry rejected");
    },
    async run({ instance }) {
      if (data.stage !== "parent") throw new Error("failed child reached executable entry");
      const process = instance.exports as Record<string, (...args: number[]) => number>;
      const memory = instance.exports.memory as WebAssembly.Memory;
      const request = new TextEncoder().encode(
        JSON.stringify({
          executable: "lazy-loader",
          argv: [],
          env: {},
          cwd: "/",
          job: -1,
          fds: [
            { parent: 1, child: 1 },
            { parent: 2, child: 2 },
          ],
        }),
      );
      new Uint8Array(memory.buffer).set(request, 1024);
      const pid = process.spawn!(1024, request.length);
      if (pid <= 0) throw new Error(`grandchild spawn failed: ${pid}`);
      let result = process.wait!(pid, 32);
      while (result === -6) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        result = process.wait!(pid, 32);
      }
      const view = new DataView(memory.buffer);
      if (result !== 0 || view.getUint32(32, true) !== 2 || view.getInt32(36, true) !== 29)
        throw new Error("grandchild did not return typed START_FAILED EIO");
      self.postMessage({ type: "quiet-grandchild-result", pid, errno: 29 });
      return 0;
    },
  });
};
