import { ProofClient, runGuest } from "./client.js";
import { SharedFilesystem } from "../../browser/shared-fs.js";

const client = new ProofClient();
let production: SharedFilesystem | undefined;
function control(): SharedFilesystem {
  if (!production) throw new Error("Production control not open");
  return production;
}
const proof = {
  client,
  runGuest: (path: string, value: string) => runGuest(client, path, value),
  productionOpen: (workspace: string) => {
    production = new SharedFilesystem({
      name: workspace,
      whenBusy: "wait",
      workerURL: "/fs-worker.js",
    });
  },
  productionState: () => production?.state.status,
  productionWrite: async () => {
    await control().writeFile("/control", "current-production");
    await control().flush();
  },
  productionRead: async () => {
    const bytes = await control().readFile("/control");
    return bytes && new TextDecoder().decode(bytes);
  },
  productionClose: async () => {
    await control().dispose();
    production = undefined;
  },
};
export type ProofPage = typeof proof;
declare global {
  var proof: ProofPage;
}
globalThis.proof = proof;
