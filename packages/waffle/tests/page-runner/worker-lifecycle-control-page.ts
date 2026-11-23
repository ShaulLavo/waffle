import { startPage } from "../../testing/page-runner/page-main.js";
import { installPublicationBootstrap } from "./publication-bootstrap.js";

installPublicationBootstrap();
declare global {
  interface Window {
    __lifecycleWorker?: Worker;
  }
}
startPage<null>({
  list: async () => ({ ids: ["lifecycle"] }),
  run: {
    kind: "host",
    peer: async () => {},
    teardown: async () => ({ settled: true }),
  },
  finish: async (ledger) => ledger.slice(),
});
