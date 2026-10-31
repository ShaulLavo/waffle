import { bootstrap, type HostProgramExecutor } from "../browser/worker.js";
import { runSearch, type SearchWorkerRequest } from "./engine.js";

const executor: HostProgramExecutor<SearchWorkerRequest> = { kind: "host", run: runSearch };
globalThis.onmessage = (event: MessageEvent<SearchWorkerRequest>) =>
  bootstrap(event.data, executor);
