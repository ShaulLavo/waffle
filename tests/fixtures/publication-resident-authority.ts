import { FilesystemClient, FilesystemService, MemoryBackend, createFilesystemConnection } from "../../fs";
import { publicationObserver, type PublicationLimits } from "../../fs/publication-internal";
import { publicationCut } from "../../fs/publication";
import { serveResidentAuthority, type ResidentAuthorityServer } from "../../browser/publication-authority";
import { record, text } from "../../fs/publication-attachment";

const limits: PublicationLimits = { sessions: 16, operations: 16, inputBytes: 64,
  argumentBytes: 512, effectBytes: 4096, effects: 16, resultBytes: 256,
  logRecords: 8, logBytes: 32768, pins: 2, pinBytes: 256 };
let backend: MemoryBackend | undefined, service: FilesystemService | undefined;
let root: FilesystemClient | undefined, server: ResidentAuthorityServer | undefined;
let handle = 0;
async function execute(operation: string, body: unknown): Promise<unknown> {
  if (operation === "start") {
    backend = new MemoryBackend();
    backend.fs.writeFile("/file", new Uint8Array([1, 2, 3]));
    service = new FilesystemService(backend);
    const connection = createFilesystemConnection(undefined, { limits, observe: true });
    service.connect(connection.server);
    root = new FilesystemClient(connection.client);
    const dir: number = await root.asyncCall("preopen", ["/"]);
    const file: { node: number } = await root.asyncCall("resolve", [dir, "file"]);
    handle = file.node;
    root.retain(handle);
    const descriptor: unknown = await root.asyncCall("publicationResident", [connection.client.publication!.observer, handle, text(body)]);
    server = await serveResidentAuthority(service.residentPublication!, new AbortController().signal);
    return descriptor;
  }
  if (!root || !backend || !service) throw new Error("authority not started");
  if (operation === "inspect") {
    const output = new Uint8Array(8).fill(90), count = root.tryRead(handle, [output], 0);
    return { count, bytes: Array.from(output), cut: await publicationObserver(root).cut(),
      lock: Atomics.load(backend.shared.cells, 1), diagnostics: backend.shared.publication!.diagnostics() };
  }
  if (operation === "bypass") {
    const read = root.tryRead(handle, [new Uint8Array(3)], 0);
    const write = root.tryWrite(handle, [new Uint8Array([77])], 0);
    let namespace = 0;
    try { await root.asyncCall("writeFile", ["/file"], new Uint8Array([88])); }
    catch (error) { namespace = Number(Reflect.get(Object(error), "errno")); }
    return { read, write, namespace, lock: Atomics.load(backend.shared.cells, 1) };
  }
  if (operation === "changes") return publicationObserver(root).changes(publicationCut(body), limits.logBytes);
  if (operation === "stop") {
    root.dispose();
    await server?.stop();
    service.dispose();
    return null;
  }
  throw new Error(`unsupported fixture operation ${operation}`);
}
self.onmessage = ({ data }: MessageEvent<unknown>) => {
  const message = record(data), id = text(message.id);
  void execute(text(message.operation), message.body).then(
    (value) => self.postMessage({ id, value }),
    (error: unknown) => self.postMessage({ id, failure: String(error) }),
  );
};
