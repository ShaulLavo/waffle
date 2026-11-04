import { resolve } from "node:path";
import { prepareCThreadsPacket } from "./c-threads-packet.js";
const [directory, artifact] = process.argv.slice(2);
if (!directory || !artifact)
  throw new Error("usage: c-threads-packet-runner.ts NEW_PACKET ARTIFACT_DIRECTORY");
console.log(JSON.stringify(await prepareCThreadsPacket(resolve(directory), resolve(artifact))));
