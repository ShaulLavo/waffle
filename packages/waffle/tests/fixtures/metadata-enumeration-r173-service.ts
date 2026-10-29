import { FilesystemService } from "../../fs/service.js";
import { createFilesystemIdentity, connectFilesystemIdentity, createFilesystemConnection } from "../../fs/protocol.js";
import type { MemoryBackend } from "../../fs/backend.js";

function checkCleanup(service: FilesystemService) {
  const { clients, retained, responses } = service.resources();
  console.log("metadata cleanup", { clients, retained, responses });
  if (clients || retained || responses)
    throw new Error("metadata fixture leaked service resources");
}

export async function metadataWorker<T>(
  backend: MemoryBackend,
  scenario: object,
  observe?: (service: FilesystemService) => void,
): Promise<T> {
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection(undefined, {
    observe: true,
    limits: {
      sessions: 8,
      operations: 16,
      inputBytes: 256,
      argumentBytes: 1024,
      effectBytes: 8192,
      effects: 64,
      resultBytes: 256,
      logRecords: 32,
      logBytes: 262144,
      pins: 4,
      pinBytes: 256,
    },
  });
  const peer = connectFilesystemIdentity(createFilesystemIdentity(connection.client), connection.pool);
  service.connect(peer.server);
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const active = new Worker(
      new URL("./metadata-enumeration-r173-worker.ts", import.meta.url).href,
    );
    worker = active;
    observe?.(service);
    service.connect(connection.server);
    const result = new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("metadata worker timed out")), 15000);
      active.onerror = reject;
      active.onmessage = (event: MessageEvent<T>) => resolve(event.data);
    });
    active.postMessage({ ...scenario, connection: connection.client, peer: peer.client }, [connection.client.port, peer.client.port]);
    return await result;
  } finally {
    clearTimeout(timer);
    await worker?.terminate();
    service.dispose();
    connection.server.port.close();
    peer.client.port.close();
    peer.server.port.close();
    checkCleanup(service);
  }
}
