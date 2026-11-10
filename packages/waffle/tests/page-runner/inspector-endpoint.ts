import { readFile, lstat } from "node:fs/promises";
import { parseReceipt, RECEIPT_MAX_BYTES } from "./inspector-endpoint-receipt.js";

/** Existing helper receipt only. No profile scan, discovery subprocess or private settings. */
export async function inspectorEndpoint(receiptPath: string, udid: string): Promise<string> {
  const bytes = await readFile(receiptPath);
  if (bytes.length > RECEIPT_MAX_BYTES)
    throw new Error("Inspector endpoint receipt bound exceeded");
  const endpoint = parseReceipt(bytes, { deviceId: udid.toUpperCase() });
  if (endpoint.kind !== "unique")
    throw new Error(`Inspector endpoint helper refused: ${endpoint.code}`);
  const node = await lstat(endpoint.socket.path);
  const expected = endpoint.socket.node;
  if (
    !node.isSocket() ||
    node.uid !== expected.uid ||
    node.dev !== expected.dev ||
    node.ino !== expected.ino ||
    node.uid !== process.getuid?.()
  )
    throw new Error("Inspector endpoint socket changed after helper discovery");
  return endpoint.socket.path;
}
