import { expect, test } from "bun:test";
import {
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  createFilesystemConnection,
} from "../fs";

test("local publication orders real host, WASI and direct writers without a nudge", async () => {
  const service = new FilesystemService(new MemoryBackend());
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const root = new FilesystemClient(connection.client);
  const sibling = new FilesystemClient(root.fork());
  try {
    await root.asyncCall("writeFile", ["/file"], new TextEncoder().encode("host"));
    const directory = await root.asyncCall("preopen", ["/"]);
    const path = await root.asyncCall("resolve", [directory, "file"]);
    root.retain(path.node);
    expect(root.tryWrite(path.node, [new TextEncoder().encode("direct")], 0)).toBe(6);
    const peerDirectory = await sibling.asyncCall("preopen", ["/"]);
    const peerPath = await sibling.asyncCall("resolve", [peerDirectory, "file"]);
    sibling.retain(peerPath.node);
    const output = new Uint8Array(6);
    expect(sibling.tryRead(peerPath.node, [output], 0)).toBe(6);
    expect(new TextDecoder().decode(output)).toBe("direct");
    const cut = await root.asyncCall("publicationCut");
    expect(cut.history).toBeString();
    expect(cut.history.length).toBeGreaterThan(0);
    expect(cut.generation).toBeGreaterThan(0);
  } finally {
    sibling.dispose();
    root.dispose();
    service.dispose();
  }
});

import { PublicationDomain, createPublicationBuffers } from "../fs/publication";
import type { PublicationLimits } from "../fs/publication-internal";

const limits: PublicationLimits = {
  sessions: 4, operations: 8, inputBytes: 64, argumentBytes: 512,
  effectBytes: 2048, effects: 16, resultBytes: 128,
  logRecords: 2, logBytes: 4096, pins: 2, pinBytes: 128,
};
function domainFixture() {
  const domain = new PublicationDomain(createPublicationBuffers(limits));
  const session = domain.openSession();
  const file = { birthHistory: domain.buffers.history, ino: 7 };
  return { domain, session, file };
}

test("bounded publication kernel retains exact receipts and refuses changed or retired identities", () => {
  const { domain, session, file } = domainFixture();
  const id = domain.next(session);
  const intent = { kind: "write", handle: 3, offset: 0 } as const;
  const input = new Uint8Array([1, 2, 3]);
  const admitted = domain.admit(session, id, intent, input);
  expect(admitted.kind).toBe("admitted");
  if (admitted.kind !== "admitted") throw new Error("missing admission");
  input.fill(9);
  expect(admitted.input).toEqual(new Uint8Array([1, 2, 3]));
  const prepared = domain.prepare(admitted.admission, { kind: "number", value: 3 }, [
    { kind: "bytes", file, offset: 0, bytes: admitted.input, size: 3, version: 1 },
    { kind: "metadata", file, mode: 0o600, mtime: 42 },
  ]);
  expect(domain.lookup(session, id)).toEqual({ kind: "pending" });
  const receipt = domain.commit(prepared);
  expect(receipt.cut.generation).toBe(1);
  expect(domain.admit(session, id, intent, new Uint8Array([1, 2, 3]))).toEqual({ kind: "duplicate", receipt });
  expect(() => domain.admit(session, id, intent, input)).toThrow("conflicting");
  expect(() => domain.admit(session, id, { ...intent, offset: 1 }, new Uint8Array([1, 2, 3]))).toThrow("conflicting");
  const changes = domain.changes({ history: receipt.cut.history, generation: 0 }, 4096);
  expect(changes.kind).toBe("changes");
  if (changes.kind !== "changes") throw new Error("missing changes");
  expect(changes.publications).toHaveLength(1);
  expect(changes.publications[0]?.changes[0]).toMatchObject({ kind: "bytes", bytes: new Uint8Array([1, 2, 3]) });
  domain.closeSession(session);
  const fresh = domain.openSession();
  expect(fresh.serial).not.toBe(session.serial);
  expect(() => domain.admit(session, id, intent, input)).toThrow("closed");
  expect(domain.lookup(fresh, id)).toEqual({ kind: "unknown" });
});

test("bounded publication kernel separates no-effect receipts, log gaps and immutable pin charges", () => {
  const { domain, session, file } = domainFixture();
  const original = domain.cut();
  const admitted = domain.admit(session, domain.next(session), { kind: "append", handle: 3 }, new Uint8Array());
  if (admitted.kind !== "admitted") throw new Error("missing admission");
  domain.commit(domain.prepare(admitted.admission, { kind: "append", written: 0, offset: 0 }, []));
  expect(domain.cut()).toEqual(original);
  const input = new Uint8Array([1]);
  const pin = domain.pin(file, 0, input);
  input[0] = 9;
  expect(pin.bytes).toEqual(new Uint8Array([1]));
  expect(domain.diagnostics()).toMatchObject({ pins: 1, pinBytes: 1 });
  domain.releasePin(pin.id);
  expect(domain.diagnostics()).toMatchObject({ pins: 0, pinBytes: 0 });
  for (let index = 0; index < 10; index++) {
    const admission = domain.admit(session, domain.next(session), { kind: "setMode", handle: 3, mode: index }, new Uint8Array());
    if (admission.kind !== "admitted") throw new Error("missing admission");
    domain.commit(domain.prepare(admission.admission, { kind: "number", value: 0 }, [{ kind: "metadata", file, mode: index, mtime: index }]));
  }
  expect(domain.lookup(session, { session: session.serial, sequence: 1 })).toEqual({ kind: "retired" });
  expect(domain.changes(original, 4096).kind).toBe("gap");
  domain.stop();
  expect(() => domain.cut()).toThrow();
  expect(() => domain.next(session)).toThrow();
  domain.releaseStopped();
  expect(domain.diagnostics()).toMatchObject({ stopped: true, sessions: 0, pending: 0, receipts: 0, pins: 0 });
});

test("publication opt-in allocates no domain by default and forks never inherit observer authority", () => {
  const ordinary = createFilesystemConnection();
  expect(ordinary.client.publication).toBeUndefined();
  ordinary.client.port.close(); ordinary.server.port.close();
  const enabled = createFilesystemConnection(undefined, { limits, observe: true });
  const fork = createFilesystemConnection(enabled.client);
  try {
    expect(enabled.client.publication?.observer).toBeString();
    expect(fork.client.publication?.observer).toBeUndefined();
    expect(fork.client.publication?.buffers.history).toBe(enabled.client.publication?.buffers.history);
    expect(fork.client.publication?.session.serial).not.toBe(enabled.client.publication?.session.serial);
  } finally {
    enabled.client.port.close(); enabled.server.port.close(); fork.client.port.close(); fork.server.port.close();
  }
});
