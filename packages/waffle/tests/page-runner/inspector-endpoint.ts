import { execFile } from "node:child_process";
import { readFile, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { parseReceipt, RECEIPT_MAX_BYTES } from "./inspector-endpoint-receipt.js";

const discover = promisify(execFile);

/** Revalidate the supplied receipt using the explicitly supplied read-only native helper. */
export async function inspectorEndpoint(
  receiptPath: string,
  udid: string,
  helperPath = process.env.WAFFLE_SAFARI_INSPECTOR_HELPER,
): Promise<string> {
  if (!isAbsolute(receiptPath) || !helperPath || !isAbsolute(helperPath))
    throw new Error(
      "Inspector endpoint requires an absolute receipt and WAFFLE_SAFARI_INSPECTOR_HELPER path",
    );
  const bytes = await readFile(receiptPath);
  if (bytes.length > RECEIPT_MAX_BYTES)
    throw new Error("Inspector endpoint receipt bound exceeded");
  const expectation = { deviceId: udid.toUpperCase() };
  const endpoint = parseReceipt(bytes, expectation);
  if (endpoint.kind !== "unique")
    throw new Error(`Inspector endpoint helper refused: ${endpoint.code}`);
  const { stdout } = await discover(
    helperPath,
    ["discover", "--udid", expectation.deviceId, "--deadline-ms", "5000"],
    { encoding: "buffer", timeout: 6000, killSignal: "SIGKILL", maxBuffer: RECEIPT_MAX_BYTES },
  );
  const current = parseReceipt(stdout, expectation);
  if (current.kind !== "unique")
    throw new Error(`Inspector endpoint live helper refused: ${current.code}`);
  if (
    current.bootSession !== endpoint.bootSession ||
    JSON.stringify(current.process) !== JSON.stringify(endpoint.process) ||
    JSON.stringify(current.socket) !== JSON.stringify(endpoint.socket)
  )
    throw new Error("Inspector endpoint live process/socket binding changed after discovery");
  const node = await lstat(current.socket.path);
  const expected = current.socket.node;
  if (
    !node.isSocket() ||
    node.uid !== expected.uid ||
    node.dev !== expected.dev ||
    node.ino !== expected.ino ||
    node.uid !== process.getuid?.()
  )
    throw new Error("Inspector endpoint socket changed after helper discovery");
  return current.socket.path;
}
