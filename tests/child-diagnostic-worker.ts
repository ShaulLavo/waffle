import { bootstrap, type RuntimeWorkerRequest } from "../browser/worker.js";

const host = globalThis as unknown as {
  onmessage: (event: MessageEvent<RuntimeWorkerRequest & { diagnostic: string }>) => void;
  postMessage(message: unknown): void;
};
const postMessage = host.postMessage.bind(host);
host.onmessage = ({ data }) => {
  void bootstrap(
    data,
    {
      setup({ fs }) {
        fs.preopen = () => 1;
        fs.retain = () => {};
        fs.release = () => {};
      },
      run() {
        const error = new Error(data.diagnostic);
        error.stack = "";
        throw error;
      },
    },
    { crossOriginIsolated: true, postMessage },
  );
};
