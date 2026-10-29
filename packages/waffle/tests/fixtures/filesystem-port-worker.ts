import { FilesystemClient, type FilesystemConnection } from "../../fs/index.js";

interface Request {
  connection: FilesystemConnection;
  id: number;
  growth?: number;
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
    result = { type: "done", id: data.id, ok: true };
  } catch (error) {
    result = { type: "done", id: data.id, ok: false, error: String(error) };
  } finally {
    fs.dispose();
  }
  self.postMessage(result);
};
self.postMessage({ type: "ready" });
