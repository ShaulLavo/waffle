import * as requests from "../fs/request-memory.js";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { FilesystemClient, FilesystemCompletion } from "../fs/client.ts";
import * as protocol from "../fs/protocol.ts";
import * as native from "../proc/intrinsics.ts";
import { localPublication } from "../fs/publication-internal.ts";
import { mutationIntent } from "../fs/publication.ts";
import { poisonProcessIntrinsics, type IntrinsicsReport } from "./fixtures/process-intrinsics.ts";

const clientSource = new Bun.Transpiler({ loader: "ts" }).transformSync(
  readFileSync(new URL("../fs/client.ts", import.meta.url), "utf8")
    .replace(/^import\b[^;]*;\n/gm, "")
    .replace(/^export /gm, "")
    .concat("\nreturn { FilesystemClient, FilesystemCompletion };\n"),
);

/** Exercise the actual client with explicit protocol/shared boundaries. Those modules have
 * their own shared-state responsibilities; their implementations are not under test here.
 * No ports, services, module mocks, or background workers are created by this fixture. */
function fixture() {
  const connection = (): protocol.FilesystemConnection => {
    const requestBudget = requests.createRequestBudget();
    const revocation = new native.SharedArrayBufferConstructor(4);
    return ({
    requestBudget,
    requests: new requests.FilesystemRequestPool(requestBudget).take(revocation),
    port: { start() {}, close() {}, postMessage() {} } as unknown as MessagePort,
    epoch: new native.SharedArrayBufferConstructor(4),
    signal: new native.SharedArrayBufferConstructor(4),
    revocations: [revocation],
    shared: new native.SharedArrayBufferConstructor(4),
    segments: [],
    capabilities: new native.SharedArrayBufferConstructor(protocol.CAPABILITY_LENGTH * 4),
    sections: new native.SharedArrayBufferConstructor(4),
    owner: 1,
    maxBytes: protocol.PAGE,
    ownerStates: new native.SharedArrayBufferConstructor(8),
    reservations: [],
  });
  };
  const source = connection(),
    target = connection();
  const targetCapabilities = new native.Int32ArrayConstructor(target.capabilities);
  for (let index = 0; index < native.typedArrayLength(targetCapabilities); index++)
    targetCapabilities[index] = -1;
  targetCapabilities[0] = 0;
  const capabilities = new native.Int32ArrayConstructor(source.capabilities);
  capabilities[protocol.CAPABILITY_HEADER] = 7;
  capabilities[protocol.CAPABILITY_HEADER + 1] = 1;
  const revocation = new native.Int32ArrayConstructor(source.revocations[0]!);
  const signal = new native.Int32ArrayConstructor(source.signal);
  const revoked = () => native.atomicsLoad(revocation, 0) !== 0;
  const wake = () => {
    native.atomicsAdd(signal, 0, 1);
    native.atomicsNotify(signal, 0);
  };
  // Predeclare every allocation so the observer recognizes buffers created after poisoning.
  const allocations = [
    new native.SharedArrayBufferConstructor(8),
  ];
  let allocation = 0;
  const captures = {
    ...native,
    SharedArrayBufferConstructor: new Proxy(native.SharedArrayBufferConstructor, {
      construct(_target, args) {
        const buffer = allocations[allocation++];
        if (!buffer || native.sharedArrayBufferByteLength(buffer) !== args[0])
          throw new Error("unexpected client allocation");
        return buffer;
      },
    }),
  };
  const bindings = {
    localPublication,
    mutationIntent,
    ...protocol,
    ...requests,
    ...captures,
    pack: () => new native.Uint8ArrayConstructor(),
    unpack: (bytes: Uint8Array) => bytes,
    isRevoked: revoked,
    sharedRevoked: () => revoked,
    wake,
    reapFilesystem() {},
    releaseFilesystemReservation(reservation: protocol.FilesystemReservation) {
      native.atomicsStore(new native.Int32ArrayConstructor(reservation.state), 0, 2);
    },
    FilesystemSection: class {
      enter() {}
      exit() {}
    },
    SharedFilesystemState: class {
      isUnlinked() {
        return false;
      }
    },
  };
  const names = Object.keys(bindings);
  const evaluate = new Function(...names.concat([clientSource]));
  const exports = evaluate(...names.map((name) => bindings[name as keyof typeof bindings])) as {
    FilesystemClient: new (connection: protocol.FilesystemConnection) => FilesystemClient;
    FilesystemCompletion: typeof FilesystemCompletion;
  };
  const client = new exports.FilesystemClient(source);
  const buffers = allocations.concat([
    source.requests.data, source.requests.control, source.requestBudget,
    source.capabilities,
    source.epoch,
    source.signal,
    source.revocations[0]!,
    source.sections,
    target.capabilities,
    target.epoch,
    target.signal,
    target.revocations[0]!,
    target.sections,
  ]);
  return { client, source, target, buffers, capabilities, revocation, wake };
}

test("filesystem client keeps completion, capability, and revocation views out of guest intrinsics", async () => {
  const { client, source, target, buffers, capabilities, revocation, wake } = fixture();
  const payload = new native.Uint8ArrayConstructor([65, 66]);
  let report: IntrinsicsReport | undefined;
  let copied: Uint8Array | undefined, copiedAsync: Uint8Array | undefined;
  let cancelled: unknown;
  let remaining = -1,
    references = -1,
    reservations = -1;
  const observer = poisonProcessIntrinsics(buffers);
  try {
    const complete = client.submit("read", [], payload, 4);
    complete.cells[0] = protocol.State.Complete;
    complete.cells[2] = 2;
    complete.cells[4] = 1;
    native.typedArraySet(
      requests.requestBytes(complete.buffer),
      payload,
    );
    copied = complete.wait();

    const completeAsync = client.submit("read", [], payload, 4);
    completeAsync.cells[0] = protocol.State.Complete;
    completeAsync.cells[2] = 2;
    completeAsync.cells[4] = 1;
    native.typedArraySet(
      requests.requestBytes(completeAsync.buffer),
      payload,
    );
    copiedAsync = await completeAsync.value();
    completeAsync.release();

    const pending = client.submit("read", [], payload, 4);
    const waiting = pending.value().catch((error) => {
      cancelled = error;
    });
    client.retain(7);
    const reservation = client.reserve(7, target);
    client.adopt(reservation);
    client.releaseReservation(reservation);
    client.release(7);
    references = capabilities[protocol.CAPABILITY_HEADER + 1]!;
    reservations = target.reservations.length;

    // The live revocation watcher cancels pending completions and wakes their value waiters.
    native.atomicsStore(revocation, 0, 1);
    wake();
    await waiting;
    complete.release();
    pending.release();
    client.dispose();
    remaining = native.mapSize(client.completions);
  } finally {
    report = observer.restore();
    // Disposal is idempotent and also covers a failure before the observed disposal path.
    client.dispose();
    source.port.close();
    target.port.close();
  }
  expect(report.leaks).toEqual([]);
  expect(report.canaries).toContain("Atomics.load");
  expect(report.canaries).toContain("TypedArray.subarray");
  expect(report.canaries).toContain("Map.set");
  expect(copied).toEqual(payload);
  expect(copiedAsync).toEqual(payload);
  expect(native.isSharedArrayBuffer(native.typedArrayBuffer(copied!))).toBe(false);
  expect(native.isSharedArrayBuffer(native.typedArrayBuffer(copiedAsync!))).toBe(false);
  expect(cancelled).toBeInstanceOf(protocol.FilesystemError);
  expect((cancelled as protocol.FilesystemError).errno).toBe(11);
  expect(remaining).toBe(0);
  expect(references).toBe(1);
  expect(reservations).toBe(1);
});
