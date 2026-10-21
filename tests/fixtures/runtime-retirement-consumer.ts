import { FilesystemClient } from "../../fs/client.js";
import { FilesystemError, isRevoked, type FilesystemConnection } from "../../fs/protocol.js";

let client: FilesystemClient | undefined;
async function receive(request: { id: number; kind: string; connection?: FilesystemConnection }) {
  if (request.kind === "start") {
    if (!request.connection) throw new Error("Missing original filesystem connection");
    client = new FilesystemClient(request.connection);
    const bytes: unknown = await client.asyncCall("readFile", ["/nested/data"]);
    if (!(bytes instanceof Uint8Array)) throw new Error("Missing seeded native data");
    return Array.from(bytes);
  }
  if (!client) throw new Error("Consumer has not started");
  if (request.kind === "ping") return "alive";
  if (request.kind === "stop") {
    client.dispose();
    return "stopped";
  }
  if (request.kind !== "revoked") throw new Error(`Unknown consumer request: ${request.kind}`);
  try {
    await client.asyncCall("readFile", ["/nested/data"]);
  } catch (error) {
    return isRevoked(client.connection) && error instanceof FilesystemError && error.errno === 11;
  }
  return false;
}

globalThis.onmessage = async (event: MessageEvent<Parameters<typeof receive>[0]>) => {
  try {
    globalThis.postMessage({ id: event.data.id, value: await receive(event.data) });
  } catch (error) {
    globalThis.postMessage({ id: event.data.id, error: String(error) });
  }
};
