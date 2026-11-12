import { PersistentBackend, FilesystemService, createFilesystemConnection } from "../fs/index.js";
import { FilesystemError, errno } from "../fs/protocol.js";
import type { StorageBackend } from "../fs/storage.js";
import { hostFilesystemClient } from "./fixtures/filesystem-host.js";
import { assert, bytes, type StorageContractCase } from "./storage-browser-helpers.js";
import { storageQuotaControl } from "./storage-quota-control.js";

function quotaPayload(): Uint8Array {
  const payload = new Uint8Array(16 * 1024 * 1024);
  for (let offset = 0; offset < payload.length; offset += 65536)
    crypto.getRandomValues(payload.subarray(offset, offset + 65536));
  return payload;
}

async function queuedFailure(storage: StorageBackend, failure?: DOMException): Promise<void> {
  const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const client = hostFilesystemClient(service, connection);
  const persist = storage.persist.bind(storage);
  const checkpoint = backend.checkpoint.bind(backend);
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const captured = Promise.withResolvers<void>();
  let armed = false;
  let background: Promise<unknown> | undefined;
  let queued: Promise<unknown> | undefined;
  storage.persist = async (batch) => {
    if (!armed) return persist(batch);
    entered.resolve();
    await released.promise;
    if (failure) throw failure;
    return persist(batch);
  };
  backend.checkpoint = (durable, target, signal) => {
    const work = checkpoint(durable, target, signal);
    if (armed && durable) captured.resolve();
    return work;
  };
  try {
    backend.execute("writeFile", ["/source"], bytes("saved source"));
    await backend.flush();
    if (!failure && !(await storageQuotaControl("cap"))) return;
    armed = true;
    backend.execute("writeFile", ["/source"], failure ? bytes("unsaved source") : quotaPayload());
    background = backend.checkpoint().catch((error: unknown) => error);
    await entered.promise;
    backend.execute("writeFile", ["/later"], bytes("latest edit"));
    queued = client.asyncCall("flush").catch((error: unknown) => error);
    await captured.promise;
    released.resolve();
    const original = await background;
    const transported = await queued;
    assert(original instanceof Error || original instanceof DOMException, "background failed");
    if (failure) assert(original === failure, "original failure identity retained");
    else assert(original.name === "QuotaExceededError", `native quota cause: ${original}`);
    assert(
      transported instanceof FilesystemError && transported.errno === errno(original),
      `queued worker protocol preserves errno ${errno(original)}: ${transported}`,
    );
    assert(errno(original) === (original.name === "QuotaExceededError" ? 51 : 29), "narrow errno");
    armed = false;
    if (!failure) await storageQuotaControl("reset");
    await backend.flush();
    assert(
      new TextDecoder().decode(await client.asyncCall("readFile", ["/later"])) === "latest edit",
      "retry retains the latest dirty tree",
    );
  } finally {
    released.resolve();
    await Promise.allSettled([background, queued]);
    armed = false;
    storage.persist = persist;
    backend.checkpoint = checkpoint;
    if (!failure) await storageQuotaControl("reset");
    client.dispose();
    service.dispose();
    await backend.close();
  }
}

export function checkpointFailureCases(): StorageContractCase[] {
  const cases: StorageContractCase[] = Array.from(
    ["QuotaExceededError", "AbortError", "UnknownError", "Error"],
    (name) => ({
      label: `checkpoint failure preserves queued ${name} at worker errno boundary`,
      run: async (_name, open) =>
        queuedFailure(await open(), new DOMException("persist failed", name)),
    }),
  );
  cases.push({
    label: "checkpoint failure preserves native quota at worker errno boundary",
    run: async (_name, open) => queuedFailure(await open()),
  });
  return cases;
}
