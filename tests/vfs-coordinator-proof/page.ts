import { ProofClient, runGuest } from "./client.js";
import { SharedFilesystem } from "../../browser/shared-fs.js";

const client = new ProofClient();
Reflect.set(globalThis, "proof", { client, runGuest: (path: string, value: string) => runGuest(client, path, value),
  SharedFilesystem, inspect: () => client.send({ kind: "inspect" }) });
export type ProofPage = typeof proof;
const proof = { client, runGuest: (path: string, value: string) => runGuest(client, path, value), SharedFilesystem };
declare global { var proof: ProofPage; }
globalThis.proof = proof;
