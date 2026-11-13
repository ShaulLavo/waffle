import { runExecWorker } from "./exec-worker.js";

self.onmessage = ({ data }) => {
  void runExecWorker(data);
};
