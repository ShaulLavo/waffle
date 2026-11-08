import { FilesystemClient, type FilesystemConnection } from "../../fs/index.js";

interface Request {
  connection: FilesystemConnection;
  id: number;
  growth?: number;
  largeBytes?: number;
}
const LARGE_ROUNDS = 5;
/** Blocking guest calls, with this worker's only view of the transferred input kept for checks. */
function checkLargeInput(fs: FilesystemClient, connection: FilesystemConnection, bytes: number) {
  const port = connection.port;
  const send = port.postMessage;
  const payloads: ArrayBuffer[] = [];
  port.postMessage = function (this: MessagePort, ...args: [any, any]) {
    if (args[0]?.payload) payloads.push(args[0].payload);
    return Reflect.apply(send, this, args);
  } as typeof port.postMessage;
  const input = new Uint8Array(bytes);
  for (let index = 0; index < bytes; index += 4093) input[index] = index % 251;
  const writes: number[] = [];
  for (let round = 0; round < LARGE_ROUNDS; round++) {
    const started = performance.now();
    fs.call("writeFile", ["/large-private"], input);
    writes.push(performance.now() - started);
  }
  port.postMessage = send;
  const output: Uint8Array = fs.call("readFile", ["/large-private"]);
  let matches = output.length === bytes;
  for (let index = 0; matches && index < bytes; index += 4093)
    matches = output[index] === input[index];
  return {
    matches,
    payloads: payloads.length,
    payloadBytes: payloads[0]?.byteLength,
    arenaBytes: connection.requests.data.byteLength,
    writeMs: writes.toSorted((a, b) => a - b)[LARGE_ROUNDS >> 1],
  };
}
function checkGrowth(fs: FilesystemClient, root: number, length?: number): void {
  if (!length) return;
  const path = fs.resolve(root, "growth.bin");
  if (typeof path === "number" || path.node === undefined) throw Error("growth file missing");
  fs.retain(path.node);
  const bytes = new Uint8Array(1);
  if (fs.read(path.node, [bytes], length - 1) !== 1 || bytes[0] !== 90)
    throw Error("prepublished segment growth was not visible");
}
self.onmessage = async ({ data }: MessageEvent<Request>) => {
  const fs = new FilesystemClient(data.connection);
  let result: Record<string, unknown>;
  try {
    const root = fs.preopen("/");
    fs.retain(root);
    checkGrowth(fs, root, data.growth);
    const path = `/probe-${data.id}`;
    await fs.asyncCall("writeFile", [path], new Uint8Array([65]));
    const bytes: Uint8Array = await fs.asyncCall("readFile", [path]);
    if (bytes.length !== 1 || bytes[0] !== 65) throw Error("request lost its file effect");
    const large = data.largeBytes
      ? checkLargeInput(fs, data.connection, data.largeBytes)
      : undefined;
    result = { type: "done", id: data.id, ok: true, large };
  } catch (error) {
    result = { type: "done", id: data.id, ok: false, error: String(error) };
  } finally {
    fs.dispose();
  }
  self.postMessage(result);
};
self.postMessage({ type: "ready" });
