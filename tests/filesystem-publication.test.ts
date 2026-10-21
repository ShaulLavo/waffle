import { expect, test } from "bun:test";
import {
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  createFilesystemConnection,
  revokeFilesystem,
  waitForFilesystemQuiescence,
} from "../fs";

async function expectErrno(action: Promise<unknown>, expected: number): Promise<void> {
  let error: unknown;
  try {
    await action;
  } catch (value) {
    error = value;
  }
  expect(error).toMatchObject({ errno: expected });
}

test("local publication orders real host, WASI and direct writers without a nudge", async () => {
  const fixture = await localPublicationFixture();
  const guestClient = new FilesystemClient(fixture.root.fork());
  const observer = publicationObserver(fixture.root);
  const memory = new WebAssembly.Memory({ initial: 4 });
  const wasi = new Wasi({
    args: [], env: {}, fs: guestClient, preopens: {}, namespaces: { env: { memory } },
    stdout() {}, stderr() {}, sleep() { throw new Error("resident WASI slept"); },
  });
  const module = publicationWasiModule();
  const guest = new WebAssembly.Instance(module, wasi.imports(module));
  const directory = await guestClient.asyncCall("preopen", ["/"]);
  const path = await guestClient.asyncCall("resolve", [directory, "file"]);
  guestClient.retain(path.node);
  const resource: Extract<Resource, { kind: "file" }> = {
    kind: "file", handle: path.node, offset: 0, append: false,
  };
  shareFileResource(resource, guestClient.connection);
  const fd = wasi.descriptors.open(resource, (1n << 1n) | (1n << 2n) | (1n << 6n), 0n);
  wasi.start(guest);
  const clients = [fixture.root, guestClient, fixture.sibling];
  const view = new DataView(memory.buffer);
  view.setUint32(0, 256, true);
  view.setUint32(4, 1, true);
  try {
    let cut = await observer.cut();
    await fixture.root.asyncCall("writeFile", ["/file"], new Uint8Array([1, 2, 3]));
    cut = await oracleSuccess(observer, cut, ["resize", "bytes", "metadata"]);
    oracleCurrent(clients, fixture.handle, [1, 2, 3]);
    new Uint8Array(memory.buffer, 256, 1)[0] = 4;
    expect(guestFunction(guest, "fd_pwrite")(fd, 0, 1, 1n, 32)).toBe(0);
    expect(view.getUint32(32, true)).toBe(1);
    expect(resource.offset).toBe(0);
    cut = await oracleSuccess(observer, cut, ["bytes", "metadata"]);
    oracleCurrent(clients, fixture.handle, [1, 4, 3]);
    expect(fixture.sibling.tryWrite(fixture.handle, [new Uint8Array([5])], 2)).toBe(1);
    cut = await oracleSuccess(observer, cut, ["bytes", "metadata"]);
    oracleCurrent(clients, fixture.handle, [1, 4, 5]);
    new Uint8Array(memory.buffer, 256, 1)[0] = 6;
    expect(guestFunction(guest, "fd_write")(fd, 0, 1, 32)).toBe(0);
    expect(view.getUint32(32, true)).toBe(1);
    expect(resource.offset).toBe(1);
    cut = await oracleSuccess(observer, cut, ["bytes", "metadata"]);
    oracleCurrent(clients, fixture.handle, [6, 4, 5]);
    // The kernel emits no publication nudge, including for this last success. Completion
    // delivery is untouched. Only explicit observer reads discover the committed group.
    expect(fixture.sibling.tryAppend(fixture.handle, [new Uint8Array([7])])).toEqual({ written: 1, offset: 4 });
    await oracleSuccess(observer, cut, ["bytes", "metadata"]);
    oracleCurrent(clients, fixture.handle, [6, 4, 5, 7]);
  } finally {
    wasi.descriptors.dispose();
    guestClient.dispose();
    fixture.stop();
  }
});

async function oracleSuccess(
  observer: ReturnType<typeof publicationObserver>,
  previous: import("../fs/publication").PublicationCut,
  kinds: readonly string[],
) {
  const page = await observer.changes(previous, limits.logBytes);
  requirePublicationGroups(page, 1);
  if (page.kind !== "changes") throw new Error("missing complete publication group");
  const group = page.publications[0]!;
  expect(group.receipt.cut).toEqual({ history: previous.history, generation: previous.generation + 1 });
  expect(group.changes.map((effect) => effect.kind)).toEqual(kinds);
  expect(group.receipt.durability).toEqual({ kind: "untracked" });
  expect(await observer.receipt(group.receipt.id)).toEqual({ kind: "committed", receipt: group.receipt });
  expect(await observer.cut()).toEqual(group.receipt.cut);
  return group.receipt.cut;
}
function oracleCurrent(clients: readonly FilesystemClient[], handle: number, expected: readonly number[]): void {
  for (const client of clients) {
    const output = new Uint8Array(expected.length);
    expect(client.tryRead(handle, [output], 0)).toBe(expected.length);
    expect(Array.from(output)).toEqual(expected);
  }
}

import { PublicationDomain, createPublicationBuffers } from "../fs/publication";
import { localPublication, publicationObserver, type PublicationLimits } from "../fs/publication-internal";
import { PAGE, reapFilesystem } from "../fs/protocol";

const limits: PublicationLimits = {
  sessions: 4,
  operations: 8,
  inputBytes: 64,
  argumentBytes: 512,
  effectBytes: 2048,
  effects: 16,
  resultBytes: 128,
  logRecords: 2,
  logBytes: 4096,
  pins: 2,
  pinBytes: 128,
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
  expect(domain.admit(session, id, intent, new Uint8Array([1, 2, 3]))).toEqual({
    kind: "duplicate",
    receipt,
  });
  expect(() => domain.admit(session, id, intent, input)).toThrow("conflicting");
  expect(() =>
    domain.admit(session, id, { ...intent, offset: 1 }, new Uint8Array([1, 2, 3])),
  ).toThrow("conflicting");
  const changes = domain.changes({ history: receipt.cut.history, generation: 0 }, 4096);
  expect(changes.kind).toBe("changes");
  if (changes.kind !== "changes") throw new Error("missing changes");
  expect(changes.publications).toHaveLength(1);
  expect(changes.publications[0]?.changes[0]).toMatchObject({
    kind: "bytes",
    bytes: new Uint8Array([1, 2, 3]),
  });
  domain.closeSession(session);
  const fresh = domain.openSession();
  expect(fresh.serial).not.toBe(session.serial);
  expect(() => domain.admit(session, id, intent, input)).toThrow("closed");
  expect(domain.lookup(fresh, id)).toEqual({ kind: "unknown" });
});

test("bounded publication kernel separates no-effect receipts, log gaps and immutable pin charges", () => {
  const { domain, session, file } = domainFixture();
  const original = domain.cut();
  const admitted = domain.admit(
    session,
    domain.next(session),
    { kind: "append", handle: 3 },
    new Uint8Array(),
  );
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
    const admission = domain.admit(
      session,
      domain.next(session),
      { kind: "setMode", handle: 3, mode: index },
      new Uint8Array(),
    );
    if (admission.kind !== "admitted") throw new Error("missing admission");
    domain.commit(
      domain.prepare(admission.admission, { kind: "number", value: 0 }, [
        { kind: "metadata", file, mode: index, mtime: index },
      ]),
    );
  }
  expect(domain.lookup(session, { session: session.serial, sequence: 1 })).toEqual({
    kind: "retired",
  });
  expect(domain.changes(original, 4096).kind).toBe("gap");
  domain.stop();
  expect(() => domain.cut()).toThrow();
  expect(() => domain.next(session)).toThrow();
  domain.releaseStopped();
  expect(domain.diagnostics()).toMatchObject({
    stopped: true,
    sessions: 0,
    pending: 0,
    receipts: 0,
    pins: 0,
  });
});

test("publication opt-in allocates no domain by default and forks never inherit observer authority", () => {
  const ordinary = createFilesystemConnection();
  expect(ordinary.client.publication).toBeUndefined();
  ordinary.client.port.close();
  ordinary.server.port.close();
  const enabled = createFilesystemConnection(undefined, { limits, observe: true });
  const fork = createFilesystemConnection(enabled.client);
  try {
    expect(enabled.client.publication?.observer).toBeString();
    expect(fork.client.publication?.observer).toBeUndefined();
    expect(fork.client.publication?.buffers.history).toBe(
      enabled.client.publication?.buffers.history,
    );
    expect(fork.client.publication?.session.serial).not.toBe(
      enabled.client.publication?.session.serial,
    );
  } finally {
    enabled.client.port.close();
    enabled.server.port.close();
    fork.client.port.close();
    fork.server.port.close();
  }
});

import { SharedFilesystemState, SLOT_WORDS } from "../fs/shared";

function directPublicationFixture() {
  const { domain, session, file } = domainFixture();
  const shared = new SharedFilesystemState(
    undefined,
    undefined,
    undefined,
    [],
    undefined,
    domain.buffers,
  );
  shared.register(
    3,
    { kind: "file", ino: file.ino, mode: 0o600, mtime: 1, size: 3 },
    new Uint8Array([1, 2, 3]),
  );
  const epoch = new Int32Array(new SharedArrayBuffer(4));
  const slot = shared.fileSlot(3);
  const admit = (input: Uint8Array, append = false, offset = 0) => {
    const intent = append
      ? ({ kind: "append", handle: 3 } as const)
      : ({ kind: "write", handle: 3, offset } as const);
    const admitted = domain.admit(session, domain.next(session), intent, input);
    if (admitted.kind !== "admitted") throw new Error("missing admission");
    return admitted;
  };
  return { domain, session, file, shared, epoch, slot, admit };
}

test("bounded publication kernel claims once and cancellation cannot erase a committed effect", () => {
  const { domain, session, file } = domainFixture();
  const admitted = domain.admit(
    session,
    domain.next(session),
    { kind: "setMode", handle: 3, mode: 0o400 },
    new Uint8Array(),
  );
  if (admitted.kind !== "admitted") throw new Error("missing admission");
  const prepared = domain.prepare(admitted.admission, { kind: "number", value: 0 }, [
    { kind: "metadata", file, mode: 0o400, mtime: 1 },
  ]);
  domain.cancel(session, admitted.admission);
  expect(domain.lookup(session, admitted.admission.id).kind).toBe("pending");
  const receipt = domain.commit(prepared);
  domain.cancel(session, admitted.admission);
  expect(domain.lookup(session, admitted.admission.id)).toEqual({ kind: "committed", receipt });
  expect(() => domain.commit(prepared)).toThrow();
  expect(domain.cut().generation).toBe(1);
});

test("bounded publication kernel cancellation releases input without waiting for the arena lock", () => {
  const { domain, session } = domainFixture();
  const admitted = domain.admit(
    session,
    domain.next(session),
    { kind: "write", handle: 3, offset: 0 },
    new Uint8Array([1]),
  );
  if (admitted.kind !== "admitted") throw new Error("missing admission");
  Atomics.store(new Int32Array(domain.buffers.control), 1, 99);
  domain.cancel(session, admitted.admission);
  expect(domain.diagnostics()).toMatchObject({ pending: 0, inputBytes: 0, receipts: 0 });
  Atomics.store(new Int32Array(domain.buffers.control), 1, 0);
  expect(domain.lookup(session, admitted.admission.id).kind).toBe("retired");
  expect(() => domain.prepare(admitted.admission, { kind: "void" }, [])).toThrow();
});

test("direct publication kernel commits owned bytes and the complete group before return", () => {
  const { domain, shared, epoch, slot, admit } = directPublicationFixture();
  const input = new Uint8Array([9, 8]);
  const admitted = admit(input);
  const before = domain.cut();
  expect(
    shared.directWrite(
      slot,
      3,
      [admitted.input],
      0,
      2,
      epoch,
      () => false,
      17,
      true,
      admitted.admission,
    ),
  ).toBe(2);
  const lookup = domain.lookupAny(admitted.admission.id);
  expect(lookup.kind).toBe("committed");
  expect(domain.cut().generation).toBe(before.generation + 1);
  const page = domain.changes(before, limits.logBytes);
  if (page.kind !== "changes") throw new Error("missing changes");
  expect(page.publications).toHaveLength(1);
  expect(page.publications[0]?.changes).toHaveLength(2);
  expect(page.publications[0]?.changes[0]).toMatchObject({
    kind: "bytes",
    bytes: input,
    offset: 0,
    size: 3,
  });
  const read = new Uint8Array(3);
  expect(shared.directRead(slot, 3, [read], 0, () => false, 18, true)).toBe(3);
  expect(read).toEqual(new Uint8Array([9, 8, 3]));
  expect(epoch[0]! & 1).toBe(0);
  expect(shared.mutate(undefined, undefined, () => shared.info(3), shared.lockOwner)?.size).toBe(3);
});

test("direct publication kernel fails before bytes on conflicts, bounds and global contention", () => {
  const { domain, session, shared, epoch, slot, admit } = directPublicationFixture();
  shared.onContention = () => {
    throw new Error("nonblocking call spun");
  };
  const admitted = admit(new Uint8Array([7]));
  const before = domain.cut();
  expect(() =>
    shared.directWrite(
      slot,
      3,
      [new Uint8Array([8])],
      0,
      1,
      epoch,
      () => false,
      17,
      true,
      admitted.admission,
    ),
  ).toThrow("conflicting");
  Atomics.store(shared.cells, 1, 99);
  const output = new Uint8Array(3).fill(42);
  expect(() => shared.directRead(slot, 3, [output], 0, () => false, 17, true)).toThrow();
  expect(() =>
    shared.directWrite(
      slot,
      3,
      [admitted.input],
      0,
      1,
      epoch,
      () => false,
      17,
      true,
      admitted.admission,
    ),
  ).toThrow();
  expect(output).toEqual(new Uint8Array(3).fill(42));
  Atomics.store(shared.cells, 1, 0);
  domain.cancel(session, admitted.admission);
  expect(domain.cut()).toEqual(before);
  expect(domain.diagnostics()).toMatchObject({ pending: 0, inputBytes: 0, receipts: 0 });
  expect(shared.snapshot(3)?.data).toEqual(new Uint8Array([1, 2, 3]));
  const lock = slot * SLOT_WORDS + 8;
  Atomics.store(shared.slots, lock, 99);
  expect(() => shared.directRead(slot, 3, [output], 0, () => false, 17, true)).toThrow();
  Atomics.store(shared.slots, lock, 0);
  expect(Atomics.load(shared.cells, 1)).toBe(0);
});

function requirePublicationGroups(
  page: { kind: string; publications?: readonly unknown[] },
  count: number,
): void {
  if (page.kind !== "changes") throw new Error("publication history gap");
  if (page.publications?.length !== count) throw new Error("missing complete publication group");
}

async function localPublicationFixture(backend = new MemoryBackend(), seed = true) {
  if (seed) backend.fs.writeFile("/file", new Uint8Array([1, 2, 3]));
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection(undefined, { limits, observe: true });
  service.connect(connection.server);
  const root = new FilesystemClient(connection.client);
  const sibling = new FilesystemClient(root.fork());
  const directory = await root.asyncCall("preopen", ["/"]);
  const path = await root.asyncCall("resolve", [directory, "file"]);
  root.retain(path.node);
  const peerDirectory = await sibling.asyncCall("preopen", ["/"]);
  const peerPath = await sibling.asyncCall("resolve", [peerDirectory, "file"]);
  sibling.retain(peerPath.node);
  const grant = connection.client.publication!.observer;
  const cut = () => root.asyncCall("publicationCut", [grant]);
  const changes = (after: unknown) =>
    root.asyncCall("publicationChanges", [grant, after, limits.logBytes]);
  const stop = () => {
    sibling.dispose();
    root.dispose();
    service.dispose();
  };
  return {
    backend,
    service,
    server: connection.server,
    root,
    sibling,
    handle: path.node as number,
    grant,
    cut,
    changes,
    stop,
  };
}

test("production publication content paths publish before direct and service success without a nudge", async () => {
  const fixture = await localPublicationFixture();
  const { root, sibling, handle, cut, changes } = fixture;
  try {
    const start = await cut();
    expect(root.tryWrite(handle, [new Uint8Array([9, 8])], 0)).toBe(2);
    const output = new Uint8Array(3);
    expect(sibling.tryRead(handle, [output], 0)).toBe(3);
    expect(output).toEqual(new Uint8Array([9, 8, 3]));
    expect(await root.asyncCall("append", [handle], new Uint8Array([7]))).toEqual({
      written: 1,
      offset: 4,
    });
    const page = await changes(start);
    requirePublicationGroups(page, 2);
    expect(page.kind).toBe("changes");
    expect(page.publications).toHaveLength(2);
    expect(
      page.publications.map((publication: { changes: unknown[] }) => publication.changes.length),
    ).toEqual([2, 2]);
    expect(
      page.publications.map(
        (publication: { receipt: { cut: { generation: number } } }) =>
          publication.receipt.cut.generation,
      ),
    ).toEqual([1, 2]);
    await expectErrno(sibling.asyncCall("publicationCut", [fixture.grant]), 2);
    await expectErrno(root.asyncCall("publicationCut"), 2);
  } finally {
    fixture.stop();
  }
});

test("production publication try I/O owns no byte work on EAGAIN and admits one bounded prefix", async () => {
  const fixture = await localPublicationFixture();
  const { root, handle, backend, cut, changes } = fixture;
  try {
    root.call = () => {
      throw new Error("blocking fallback");
    };
    root.shared.onContention = () => {
      throw new Error("blocking contention");
    };
    const start = await cut();
    const before = backend.shared.revision(handle);
    Atomics.store(root.shared.cells, 1, 99);
    expect(root.tryWrite(handle, [new Uint8Array([90])], 0)).toBe(-6);
    const output = new Uint8Array(3).fill(42);
    expect(root.tryRead(handle, [output], 0)).toBe(-6);
    expect(output).toEqual(new Uint8Array(3).fill(42));
    Atomics.store(root.shared.cells, 1, 0);
    expect(backend.shared.revision(handle)).toBe(before);
    expect(backend.shared.publication!.diagnostics()).toMatchObject({ pending: 0, inputBytes: 0 });
    expect(await cut()).toEqual(start);
    expect(root.tryWrite(handle, [new Uint8Array(128).fill(90)], 0)).toBe(64);
    const page = await changes(start);
    expect(page.publications).toHaveLength(1);
    expect(page.publications[0].receipt.result).toEqual({ kind: "number", value: 64 });
    expect(backend.shared.stat(handle)?.size).toBe(64);
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect((await changes(start)).publications).toHaveLength(1);
  } finally {
    Atomics.store(root.shared.cells, 1, 0);
    fixture.stop();
  }
});

test("production compound writeFile refuses over-bound input before changes", async () => {
  const fixture = await localPublicationFixture();
  try {
    const start = await fixture.cut();
    await expectErrno(
      fixture.root.asyncCall("writeFile", ["/file"], new Uint8Array(65).fill(9)),
      6,
    );
    expect(await fixture.cut()).toEqual(start);
    expect(fixture.backend.shared.snapshot(fixture.handle)?.data).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(fixture.backend.fs.lookup("/missing")).toBeUndefined();
    expect(fixture.backend.shared.publication!.diagnostics().pending).toBe(0);
  } finally {
    fixture.stop();
  }
});

import { Wasi } from "../core/wasi";
import { DescriptorTable, type Resource } from "../core/descriptors";
import { shareFileResource } from "../core/open-file";
import { ProcessABI, type ProcessService } from "../proc/abi";
import { createSignalState } from "../proc/signals";
import { outcomeWord } from "../proc/outcome";
import {
  guestFunction,
  publicationProcModule,
  publicationWasiModule,
} from "./fixtures/publication-wasm";

function unusedProcessService(): ProcessService {
  const unused = (): never => {
    throw new Error("unexpected process service call");
  };
  return {
    spawn: unused,
    startStatus: unused,
    waitJob: unused,
    jobEmpty: unused,
    wait: unused,
    childExited: unused,
    kill: unused,
    killJob: unused,
    jobOf: unused,
    defaultSignal: unused,
  };
}

test("real runtime_proc Wasm publication I/O returns EAGAIN without offsets, output or events", async () => {
  const fixture = await localPublicationFixture();
  const { root, handle } = fixture;
  const descriptors = new DescriptorTable();
  const resource: Extract<Resource, { kind: "file" }> = {
    kind: "file",
    handle,
    offset: 0,
    append: false,
  };
  shareFileResource(resource, root.connection);
  const fd = descriptors.open(resource, (1n << 1n) | (1n << 2n) | (1n << 6n), 0n);
  const memory = new WebAssembly.Memory({ initial: 4 });
  const abi = new ProcessABI({
    memory,
    descriptors,
    fs: root,
    pid: 1,
    service: unusedProcessService(),
    signals: {
      signalState: createSignalState(),
      interrupt: new Int32Array(new SharedArrayBuffer(4)),
      requestedSignal: new Int32Array(new SharedArrayBuffer(4)),
      outcome: outcomeWord(),
    },
    wait() {
      throw new Error("nonblocking Wasm slept");
    },
  });
  const guest = new WebAssembly.Instance(publicationProcModule(), {
    env: { memory },
    runtime_proc: abi.imports,
  });
  const write = guestFunction(guest, "write"),
    read = guestFunction(guest, "read");
  root.call = () => {
    throw new Error("nonblocking Wasm used blocking RPC");
  };
  root.shared.onContention = () => {
    throw new Error("nonblocking Wasm spun");
  };
  try {
    const start = await fixture.cut();
    new Uint8Array(memory.buffer, 256, 3).fill(42);
    Atomics.store(root.shared.cells, 1, 99);
    expect(write(fd, 256, 1)).toBe(-6);
    expect(read(fd, 256, 3)).toBe(-6);
    expect(resource.offset).toBe(0);
    expect(new Uint8Array(memory.buffer, 256, 3)).toEqual(new Uint8Array(3).fill(42));
    Atomics.store(root.shared.cells, 1, 0);
    expect(await fixture.cut()).toEqual(start);
    expect(write(fd, 256, 1)).toBe(1);
    expect(resource.offset).toBe(1);
    expect((await fixture.changes(start)).publications).toHaveLength(1);
  } finally {
    Atomics.store(root.shared.cells, 1, 0);
    descriptors.dispose();
    fixture.stop();
  }
});

test("real WASI exported Wasm functions publish positioned and offset writes", async () => {
  const fixture = await localPublicationFixture();
  const memory = new WebAssembly.Memory({ initial: 4 });
  const wasi = new Wasi({
    args: [],
    env: {},
    fs: fixture.root,
    preopens: {},
    namespaces: { env: { memory } },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  const module = publicationWasiModule();
  const guest = new WebAssembly.Instance(module, { ...wasi.imports(module), env: { memory } });
  const resource: Extract<Resource, { kind: "file" }> = {
    kind: "file",
    handle: fixture.handle,
    offset: 0,
    append: false,
  };
  shareFileResource(resource, fixture.root.connection);
  const fd = wasi.descriptors.open(resource, (1n << 1n) | (1n << 2n) | (1n << 6n), 0n);
  wasi.start(guest);
  try {
    const start = await fixture.cut();
    const view = new DataView(memory.buffer);
    view.setUint32(0, 256, true);
    view.setUint32(4, 2, true);
    new Uint8Array(memory.buffer, 256, 2).set([8, 9]);
    expect(guestFunction(guest, "fd_pwrite")(fd, 0, 1, 1n, 32)).toBe(0);
    expect(view.getUint32(32, true)).toBe(2);
    expect(resource.offset).toBe(0);
    expect(guestFunction(guest, "fd_write")(fd, 0, 1, 32)).toBe(0);
    expect(resource.offset).toBe(2);
    expect((await fixture.changes(start)).publications).toHaveLength(2);
  } finally {
    wasi.descriptors.dispose();
    fixture.stop();
  }
});

test("uninstrumented completion errors preserve ordinary delivery", async () => {
  const service = new FilesystemService(new MemoryBackend());
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const root = new FilesystemClient(connection.client);
  try {
    for (let index = 0; index < 3; index++) {
      await expectErrno(root.asyncCall("unknown-operation"), 52);
    }
  } finally {
    root.dispose();
    service.dispose();
  }
});

function workerMessage(worker: Worker): Promise<unknown> {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => resolve(data);
    worker.onerror = reject;
  });
}

test("separate real Wasm workers publish to the same production root and keep try I/O nonblocking", async () => {
  const fixture = await localPublicationFixture();
  const workers: Worker[] = [];
  const connections: ReturnType<FilesystemClient["fork"]>[] = [];
  try {
    const start = await fixture.cut();
    for (const mode of ["wasi", "proc"]) {
      const worker = new Worker(new URL("./fixtures/publication-guest.ts", import.meta.url).href);
      workers.push(worker);
      const connection = fixture.root.fork();
      connections.push(connection);
      const message = workerMessage(worker);
      worker.postMessage({ connection, mode }, [connection.port]);
      expect(await message).toEqual({ ready: true });
    }
    let message = workerMessage(workers[0]!);
    workers[0]!.postMessage({ operation: "write", byte: 8 });
    expect(await message).toEqual({ result: 0, offset: 0, byte: 8, count: 1 });
    expect((await fixture.changes(start)).publications).toHaveLength(1);
    const committed = await fixture.cut();
    Atomics.store(fixture.root.shared.cells, 1, 99);
    message = workerMessage(workers[1]!);
    workers[1]!.postMessage({ operation: "write", byte: 9 });
    expect(await message).toEqual({ result: -6, offset: 0, byte: 9, count: 0xdeadbeef });
    message = workerMessage(workers[1]!);
    workers[1]!.postMessage({ operation: "read", byte: 42 });
    expect(await message).toEqual({ result: -6, offset: 0, byte: 42, count: 0xdeadbeef });
    Atomics.store(fixture.root.shared.cells, 1, 0);
    expect(await fixture.cut()).toEqual(committed);
    message = workerMessage(workers[1]!);
    workers[1]!.postMessage({ operation: "write", byte: 9 });
    expect(await message).toEqual({ result: 1, offset: 1, byte: 9, count: 0xdeadbeef });
    const page = await fixture.changes(start);
    expect(page.publications).toHaveLength(2);
    expect(page.publications[0].receipt.id.session).not.toBe(
      page.publications[1].receipt.id.session,
    );
    const bytes = new Uint8Array(3);
    expect(fixture.sibling.tryRead(fixture.handle, [bytes], 0)).toBe(3);
    expect(bytes).toEqual(new Uint8Array([9, 2, 3]));
    for (const worker of workers) {
      message = workerMessage(worker);
      worker.postMessage("stop");
      expect(await message).toEqual({ stopped: true });
    }
  } finally {
    Atomics.store(fixture.root.shared.cells, 1, 0);
    for (const worker of workers) worker.terminate();
    for (const connection of connections) reapFilesystem(connection);
    fixture.stop();
  }
});

test("production publication growth prepares no bytes and retry captures the new input", async () => {
  const fixture = await localPublicationFixture();
  try {
    const start = await fixture.cut();
    const revision = fixture.backend.shared.revision(fixture.handle);
    const bytes = new Uint8Array([8]);
    expect(fixture.root.tryWrite(fixture.handle, [bytes], PAGE)).toBe(-6);
    expect(fixture.backend.shared.publication!.diagnostics()).toMatchObject({
      pending: 0,
      inputBytes: 0,
    });
    bytes[0] = 9;
    const pending = Array.from(fixture.root.completions.values());
    expect(pending).toHaveLength(1);
    await pending[0]!.value();
    expect(await fixture.cut()).toEqual(start);
    expect(fixture.backend.shared.stat(fixture.handle)?.size).toBe(3);
    expect(fixture.backend.shared.revision(fixture.handle)).toBe(revision);
    expect(fixture.root.tryWrite(fixture.handle, [bytes], PAGE)).toBe(1);
    const output = new Uint8Array(1);
    expect(fixture.sibling.tryRead(fixture.handle, [output], PAGE)).toBe(1);
    expect(output).toEqual(new Uint8Array([9]));
    const page = await fixture.changes(start);
    expect(page.publications).toHaveLength(1);
    expect(page.publications[0].receipt.result).toEqual({ kind: "number", value: 1 });
  } finally {
    fixture.stop();
  }
});

import { PersistentBackend } from "../fs/persistent";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function coldPublicationFixture() {
  const reading = deferred(),
    release = deferred();
  let reads = 0,
    hydrations = 0;
  const backend = await PersistentBackend.open(
    {
      async load() {
        return {
          version: 1,
          generation: 1,
          root: 100,
          nodes: [
            { ino: 100, kind: "dir", mode: 0o700, size: 0, mtime: 1, children: [["file", 101]] },
            { ino: 101, kind: "file", mode: 0o600, size: 3, mtime: 1, data: "fixture-payload" },
          ],
        };
      },
      async read() {
        reads++;
        reading.resolve();
        await release.promise;
        return new Uint8Array([1, 2, 3]);
      },
      async persist() {},
      async flush() {},
      async close() {},
    },
    { intervalMs: 0 },
  );
  const fixture = await localPublicationFixture(backend, false);
  const hydrate = backend.shared.hydrate.bind(backend.shared);
  backend.shared.hydrate = (handle, bytes) => {
    hydrations++;
    return hydrate(handle, bytes);
  };
  return {
    ...fixture,
    backend,
    reading: reading.promise,
    release: release.resolve,
    reads: () => reads,
    hydrations: () => hydrations,
  };
}

test("real paused persistent load cannot hydrate after the production domain stops", async () => {
  const fixture = await coldPublicationFixture();
  let loading: void | Promise<void> = undefined;
  try {
    const output = new Uint8Array(3).fill(42);
    expect(fixture.root.tryRead(fixture.handle, [output], 0)).toBe(-6);
    await fixture.reading;
    loading = fixture.backend.prepare("read", [fixture.handle]);
    const domain = fixture.backend.shared.publication!;
    const before = domain.diagnostics();
    expect(fixture.reads()).toBe(1);
    await expectErrno(fixture.root.asyncCall("publicationStop", [fixture.grant]), 11);
    fixture.release();
    await loading;
    expect(fixture.hydrations()).toBe(0);
    expect(fixture.backend.shared.isResident(fixture.handle)).toBe(false);
    expect(output).toEqual(new Uint8Array(3).fill(42));
    expect(fixture.root.tryRead(fixture.handle, [output], 0)).toBe(-11);
    expect(fixture.sibling.tryWrite(fixture.handle, [new Uint8Array([9])], 0)).toBe(-11);
    expect(domain.diagnostics()).toMatchObject({
      stopped: true,
      sessions: 0,
      pending: 0,
      receipts: 0,
      pins: 0,
      pinBytes: 0,
      inputBytes: 0,
    });
    expect(before.stopped).toBe(false);
    expect(fixture.service.resources()).toMatchObject({ clients: 0, retained: 0, responses: 0 });
  } finally {
    fixture.release();
    await loading;
    fixture.stop();
    fixture.backend.dispose();
  }
});

test("cancelling one cold session preserves the live peer and its real shared load", async () => {
  const fixture = await coldPublicationFixture();
  let loading: void | Promise<void> = undefined;
  try {
    const start = await fixture.cut();
    expect(fixture.sibling.tryWrite(fixture.handle, [new Uint8Array([8])], 0)).toBe(-6);
    expect(fixture.root.tryRead(fixture.handle, [new Uint8Array(3)], 0)).toBe(-6);
    await fixture.reading;
    loading = fixture.backend.prepare("read", [fixture.handle]);
    fixture.sibling.dispose();
    fixture.service.sweep();
    expect(fixture.service.resources().clients).toBe(1);
    fixture.release();
    await loading;
    expect(fixture.reads()).toBe(1);
    expect(fixture.hydrations()).toBe(1);
    const pending = Array.from(fixture.root.completions.values());
    expect(pending).toHaveLength(1);
    await pending[0]!.value();
    const output = new Uint8Array(3);
    expect(fixture.root.tryRead(fixture.handle, [output], 0)).toBe(3);
    expect(output).toEqual(new Uint8Array([1, 2, 3]));
    const domain = fixture.backend.shared.publication!;
    expect(domain.cut()).toEqual(start);
    expect(domain.diagnostics()).toMatchObject({
      stopped: false,
      sessions: 1,
      pending: 0,
      inputBytes: 0,
    });
  } finally {
    fixture.release();
    await loading;
    fixture.stop();
    fixture.backend.dispose();
  }
});

test("resident direct metadata joins the publication order and chmod revokes an open description", async () => {
  const fixture = await localPublicationFixture();
  try {
    const start = await fixture.cut();
    fixture.root.call = () => {
      throw new Error("resident metadata used blocking RPC");
    };
    expect(fixture.root.resize(fixture.handle, 6, false)).toBe(0);
    const resized = await fixture.cut();
    expect(resized.generation).toBe(start.generation + 1);
    expect(fixture.sibling.tryRead(fixture.handle, [new Uint8Array(6)], 0)).toBe(6);
    expect(fixture.root.setMtime(fixture.handle, 77)).toBe(0);
    expect(fixture.sibling.shared.stat(fixture.handle)?.mtime).toBe(77);
    const page = await fixture.changes(start);
    expect(page.publications).toHaveLength(2);
    expect(page.publications[0].changes[0]).toMatchObject({ kind: "resize", size: 6 });
    expect(page.publications[1].changes).toEqual([
      { kind: "metadata", file: page.publications[0].changes[0].file, mode: 0o600, mtime: 77 },
    ]);
    const inode = fixture.sibling.shared.stat(fixture.handle)?.ino;
    expect(await fixture.root.asyncCall("setMode", [fixture.handle, 0o400])).toBe(0);
    const denied = await fixture.cut();
    expect(fixture.root.tryWrite(fixture.handle, [new Uint8Array([9])], 0)).toBe(-2);
    expect(fixture.root.setMtime(fixture.handle, 88)).toBe(2);
    expect(await fixture.cut()).toEqual(denied);
    expect(await fixture.root.asyncCall("setMode", [fixture.handle, 0o600])).toBe(0);
    expect(fixture.root.tryWrite(fixture.handle, [new Uint8Array([9])], 0)).toBe(1);
    expect(fixture.sibling.shared.stat(fixture.handle)?.ino).toBe(inode);
  } finally {
    fixture.stop();
  }
});

test("production namespace plans publish implicit parents and reject over-bound plans without edits", async () => {
  const fixture = await localPublicationFixture();
  try {
    const start = await fixture.cut();
    const before = fixture.backend.shared.resources();
    await expectErrno(fixture.root.asyncCall("mkdirp", ["/a/b/c/d/e/f"]), 6);
    expect(fixture.backend.fs.lookup("/a")).toBeUndefined();
    expect(await fixture.cut()).toEqual(start);
    expect(fixture.backend.shared.resources()).toEqual(before);
    const directory = await fixture.root.asyncCall("preopen", ["/a/b"]);
    fixture.root.retain(directory);
    const page = await fixture.changes(start);
    expect(page.publications).toHaveLength(1);
    expect(
      page.publications[0].changes.filter((effect: { kind: string }) => effect.kind === "inode"),
    ).toHaveLength(2);
    expect(
      page.publications[0].changes
        .filter((effect: { kind: string }) => effect.kind === "entry")
        .map((effect: { name: string }) => effect.name),
    ).toEqual(["a", "b"]);
    expect(
      (await fixture.root.asyncCall("readdir", [directory])).map(
        (entry: { name: string }) => entry.name,
      ),
    ).toEqual([".", ".."]);
    const after = await fixture.cut();
    await fixture.root.asyncCall("mkdirp", ["/a/b"]);
    expect(await fixture.cut()).toEqual(after);
  } finally {
    fixture.stop();
  }
});

test("production namespace rename and unlink preserve distinct retained file identities", async () => {
  const fixture = await localPublicationFixture();
  try {
    const directory = await fixture.root.asyncCall("preopen", ["/"]);
    const resolve = (name: string) => fixture.root.asyncCall("resolve", [directory, name]);
    const target = await fixture.root.asyncCall("create", [await resolve("target"), "file", true]);
    fixture.root.retain(target);
    await fixture.root.asyncCall("grow", [target, 1]);
    expect(fixture.root.tryWrite(target, [new Uint8Array([4])], 0)).toBe(1);
    const sourceKey = fixture.root.shared.stat(fixture.handle)!.ino;
    const targetKey = fixture.root.shared.stat(target)!.ino;
    expect(sourceKey).not.toBe(targetKey);
    const before = await fixture.cut();
    expect(
      await fixture.root.asyncCall("rename", [await resolve("file"), await resolve("target")]),
    ).toBe(0);
    const group = (await fixture.changes(before)).publications[0];
    expect(
      group.changes.filter((effect: { kind: string }) => effect.kind === "entry"),
    ).toHaveLength(2);
    expect(
      group.changes.filter((effect: { kind: string }) => effect.kind === "metadata"),
    ).toHaveLength(1);
    expect((await resolve("target")).node).toBe(fixture.handle);
    expect(fixture.root.tryWrite(fixture.handle, [new Uint8Array([8])], 0)).toBe(1);
    expect(fixture.root.tryWrite(target, [new Uint8Array([9])], 0)).toBe(1);
    expect(
      await fixture.root.asyncCall("link", [await resolve("target"), await resolve("alias")]),
    ).toBe(0);
    expect(await fixture.root.asyncCall("removePath", [await resolve("target"), false])).toBe(0);
    expect((await resolve("alias")).node).toBe(fixture.handle);
    expect(await fixture.root.asyncCall("removePath", [await resolve("alias"), false])).toBe(0);
    const source = new Uint8Array(3),
      replaced = new Uint8Array(1);
    expect(fixture.root.tryRead(fixture.handle, [source], 0)).toBe(3);
    expect(source).toEqual(new Uint8Array([8, 2, 3]));
    expect(fixture.root.tryRead(target, [replaced], 0)).toBe(1);
    expect(replaced).toEqual(new Uint8Array([9]));
    expect(fixture.root.shared.stat(fixture.handle)!.ino).toBe(sourceKey);
    expect(fixture.root.shared.stat(target)!.ino).toBe(targetKey);
  } finally {
    fixture.stop();
  }
});

test("production recursive removal publishes every edge and retained directory cannot grow names", async () => {
  const fixture = await localPublicationFixture();
  try {
    const parent = await fixture.root.asyncCall("preopen", ["/tree/child"]);
    fixture.root.retain(parent);
    const path = await fixture.root.asyncCall("resolve", [parent, "leaf"]);
    const file = await fixture.root.asyncCall("create", [path, "file", true]);
    fixture.root.retain(file);
    await fixture.root.asyncCall("grow", [file, 1]);
    expect(fixture.root.tryWrite(file, [new Uint8Array([7])], 0)).toBe(1);
    const before = await fixture.cut();
    expect(await fixture.root.asyncCall("remove", ["/tree"])).toBe(true);
    const group = (await fixture.changes(before)).publications[0];
    expect(
      group.changes
        .filter((effect: { kind: string }) => effect.kind === "entry")
        .map((effect: { name: string }) => effect.name)
        .sort(),
    ).toEqual(["child", "leaf", "tree"]);
    expect(await fixture.root.asyncCall("listFiles", ["/"])).toEqual(["/file"]);
    expect(fixture.root.tryRead(file, [new Uint8Array(1)], 0)).toBe(1);
    const missing = await fixture.root.asyncCall("resolve", [parent, "new"]);
    expect(await fixture.root.asyncCall("create", [missing, "file", true])).toEqual({ error: 44 });
    const after = await fixture.cut();
    expect(await fixture.root.asyncCall("remove", ["/tree"])).toBe(false);
    expect(await fixture.cut()).toEqual(after);
  } finally {
    fixture.stop();
  }
});

test("production host replace append exclusive and move each publish one complete group", async () => {
  const fixture = await localPublicationFixture();
  try {
    const start = await fixture.cut();
    await fixture.root.asyncCall("writeFile", ["/file"], new Uint8Array([9, 8]));
    let page = await fixture.changes(start);
    expect(page.publications).toHaveLength(1);
    expect(page.publications[0].changes.map((effect: { kind: string }) => effect.kind)).toEqual([
      "resize",
      "bytes",
      "metadata",
    ]);
    expect(await fixture.root.asyncCall("readFile", ["/file"])).toEqual(new Uint8Array([9, 8]));
    let before = await fixture.cut();
    await fixture.root.asyncCall("writeFile", ["/file", true], new Uint8Array([7]));
    page = await fixture.changes(before);
    expect(page.publications).toHaveLength(1);
    expect(page.publications[0].changes[0]).toMatchObject({ kind: "bytes", offset: 2, size: 3 });
    expect(await fixture.root.asyncCall("readFile", ["/file"])).toEqual(new Uint8Array([9, 8, 7]));
    before = await fixture.cut();
    await expectErrno(
      fixture.root.asyncCall("writeFile", ["/file", false, true], new Uint8Array([1])),
      20,
    );
    expect(await fixture.cut()).toEqual(before);
    await expectErrno(
      fixture.root.asyncCall("writeFile", ["/a/b/c/d/e/file"], new Uint8Array([1])),
      6,
    );
    expect(fixture.backend.fs.lookup("/a")).toBeUndefined();
    expect(await fixture.cut()).toEqual(before);
    await fixture.root.asyncCall("writeFile", ["/new/child", false, true], new Uint8Array([6]));
    page = await fixture.changes(before);
    expect(page.publications).toHaveLength(1);
    expect(
      page.publications[0].changes.filter((effect: { kind: string }) => effect.kind === "inode"),
    ).toHaveLength(2);
    expect(
      page.publications[0].changes.filter((effect: { kind: string }) => effect.kind === "entry"),
    ).toHaveLength(2);
    expect(await fixture.root.asyncCall("readFile", ["/new/child"])).toEqual(new Uint8Array([6]));
    before = await fixture.cut();
    expect(await fixture.root.asyncCall("move", ["/new/child", "/new/moved"])).toBe(0);
    expect((await fixture.changes(before)).publications).toHaveLength(1);
    expect(await fixture.root.asyncCall("listFiles", ["/"])).toEqual(["/file", "/new/moved"]);
  } finally {
    fixture.stop();
  }
});

test("production copied pins preserve a content version across metadata and later bytes", async () => {
  const fixture = await localPublicationFixture();
  try {
    const { root, grant, handle } = fixture;
    expect(root.tryWrite(handle, [new Uint8Array([8])], 0)).toBe(1);
    const pin = await root.asyncCall("publicationPin", [grant, handle, 0, 3]);
    expect(pin.version).toBe(1);
    expect(pin.bytes).toEqual([8, 2, 3]);
    await root.asyncCall("setMode", [handle, 0o400]);
    const metadata = await root.asyncCall("publicationPin", [grant, handle, 0, 3]);
    expect(metadata.version).toBe(pin.version);
    expect(metadata.cut.generation).toBeGreaterThan(pin.cut.generation);
    await expectErrno(root.asyncCall("publicationPin", [grant, handle, 0, 3]), 6);
    await root.asyncCall("publicationReleasePin", [grant, metadata.id]);
    await root.asyncCall("setMode", [handle, 0o600]);
    expect(root.tryWrite(handle, [new Uint8Array([9])], 0)).toBe(1);
    const current = await root.asyncCall("publicationPin", [grant, handle, 0, 3]);
    expect(current.version).toBe(2);
    expect(current.bytes).toEqual([9, 2, 3]);
    expect(pin.bytes).toEqual([8, 2, 3]);
    expect((await fixture.changes(pin.cut)).kind).toBe("gap");
    await root.asyncCall("publicationReleasePin", [grant, pin.id]);
    await root.asyncCall("publicationReleasePin", [grant, current.id]);
    expect(await root.asyncCall("publicationDiagnostics", [grant])).toMatchObject({
      pins: 0,
      pinBytes: 0,
    });
    await root.asyncCall("setMode", [handle, 0o200]);
    await expectErrno(root.asyncCall("publicationPin", [grant, handle, 0, 3]), 2);
    expect(await root.asyncCall("publicationDiagnostics", [grant])).toMatchObject({
      pins: 0,
      pinBytes: 0,
    });
  } finally {
    fixture.stop();
  }
});

test("production exact identities survive after-commit response loss and cannot replay retired work", async () => {
  const fixture = await localPublicationFixture();
  const post = fixture.server.port.postMessage.bind(fixture.server.port);
  const delivered = deferred();
  let dropped = -1;
  fixture.server.port.postMessage = (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      "completed" in message &&
      message.completed === dropped
    ) {
      delivered.resolve();
      return;
    }
    post(message);
  };
  try {
    const before = await fixture.cut();
    const args = [fixture.handle, 0],
      data = new Uint8Array([9]);
    const admitted = fixture.root[localPublication]("write", args, data);
    if (admitted.kind !== "admitted") throw new Error("expected new identity");
    const completion = fixture.root.submit(
      "write",
      args,
      admitted.input,
      undefined,
      admitted.admission,
    );
    dropped = completion.id;
    await delivered.promise;
    completion.cancel();
    completion.release();
    const receipt = await fixture.root.asyncCall("publicationReceipt", [
      fixture.grant,
      admitted.admission.id,
    ]);
    expect(receipt.kind).toBe("committed");
    expect(receipt.receipt.result).toEqual({ kind: "number", value: 1 });
    expect(receipt.receipt.cut.generation).toBe(before.generation + 1);
    const duplicate = fixture.root[localPublication]("write", args, data, admitted.admission.id);
    expect(duplicate).toEqual({ kind: "duplicate", receipt: receipt.receipt });
    expect(() =>
      fixture.root[localPublication]("write", args, new Uint8Array([8]), admitted.admission.id),
    ).toThrow("conflicting");
    expect(() =>
      fixture.root[localPublication]("write", [fixture.handle, 1], data, admitted.admission.id),
    ).toThrow("conflicting");
    expect(() =>
      fixture.root[localPublication]("append", [fixture.handle], data, admitted.admission.id),
    ).toThrow("conflicting");
    expect(() =>
      fixture.root[localPublication]("write", [999, 0], data, admitted.admission.id),
    ).toThrow("conflicting");
    expect((await fixture.changes(before)).publications).toHaveLength(1);
    const after = await fixture.cut();
    for (let index = 0; index < limits.operations; index++)
      await fixture.root.asyncCall("setMtime", [fixture.handle, 100 + index]);
    expect(
      (await fixture.root.asyncCall("publicationReceipt", [fixture.grant, admitted.admission.id]))
        .kind,
    ).toBe("retired");
    expect(() =>
      fixture.root[localPublication]("write", args, data, admitted.admission.id),
    ).toThrow("retired");
    expect((await fixture.cut()).generation).toBe(after.generation + limits.operations);
    fixture.sibling.dispose();
    expect(() =>
      fixture.sibling[localPublication]("write", args, data, admitted.admission.id),
    ).toThrow();
  } finally {
    fixture.server.port.postMessage = post;
    fixture.stop();
  }
});

test("production publication oracle detects a disabled direct commit and a stale observer cut", async () => {
  const fixture = await localPublicationFixture();
  const domain = fixture.root.shared.publication!,
    commit = domain.commit.bind(domain);
  try {
    const start = await fixture.cut();
    domain.commit = (prepared) => prepared.receipt;
    expect(fixture.root.tryWrite(fixture.handle, [new Uint8Array([9])], 0)).toBe(1);
    expect(fixture.backend.shared.snapshot(fixture.handle)?.data).toEqual(
      new Uint8Array([9, 2, 3]),
    );
    expect(() => requirePublicationGroups({ kind: "changes", publications: [] }, 1)).toThrow(
      "missing complete publication group",
    );
    const missing = await fixture.changes(start);
    expect(() => requirePublicationGroups(missing, 1)).toThrow(
      "missing complete publication group",
    );
    domain.commit = commit;
    for (const byte of [6, 7, 8])
      expect(fixture.root.tryWrite(fixture.handle, [new Uint8Array([byte])], 0)).toBe(1);
    const stale = await fixture.changes(start);
    expect(() => requirePublicationGroups(stale, 3)).toThrow("publication history gap");
  } finally {
    domain.commit = commit;
    fixture.stop();
  }
});

test("production current cached and host reads recheck traversal permissions and metadata", async () => {
  const fixture = await localPublicationFixture();
  try {
    await fixture.root.asyncCall("writeFile", ["/dir/child"], new Uint8Array([4]));
    const parent = await fixture.root.asyncCall("preopen", ["/dir"]);
    fixture.root.retain(parent);
    const child = await fixture.root.asyncCall("resolve", [parent, "child"]);
    fixture.root.retain(child.node);
    const before = await fixture.cut();
    expect(fixture.root.stat(child.node).size).toBe(1);
    expect(fixture.root.permissions(child.node)?.access).toBe(6);
    expect(await fixture.root.asyncCall("resize", [child.node, 2, false])).toBe(0);
    expect(fixture.root.stat(child.node).size).toBe(2);
    expect(await fixture.root.asyncCall("setMtime", [child.node, 55])).toBe(0);
    expect(fixture.root.stat(child.node).mtime).toBe(55);
    expect(await fixture.root.asyncCall("setMode", [parent, 0o600])).toBe(0);
    const denied = await fixture.cut();
    await expectErrno(fixture.root.asyncCall("readFile", ["/dir/child"]), 2);
    expect(await fixture.root.asyncCall("resolve", [parent, "child"])).toBe(2);
    await expectErrno(fixture.root.asyncCall("listFiles", ["/dir"]), 2);
    expect(await fixture.cut()).toEqual(denied);
    expect(await fixture.root.asyncCall("setMode", [parent, 0o700])).toBe(0);
    expect(await fixture.root.asyncCall("readFile", ["/dir/child"])).toEqual(
      new Uint8Array([4, 0]),
    );
    expect((await fixture.root.asyncCall("lookup", ["/dir"])).children.size).toBe(1);
    expect((await fixture.changes(before)).kind).toBe("gap");
  } finally {
    fixture.stop();
  }
});

test("production no-effect receipts do not advance cuts and clean slot eviction preserves content versions", async () => {
  const fixture = await localPublicationFixture();
  try {
    const before = await fixture.cut();
    const receipts = fixture.backend.shared.publication!.diagnostics().receipts;
    expect(await fixture.root.asyncCall("write", [fixture.handle, 0], new Uint8Array())).toBe(0);
    expect(fixture.root.tryAppend(fixture.handle, [])).toEqual({ written: 0, offset: 3 });
    expect(await fixture.cut()).toEqual(before);
    expect(fixture.backend.shared.publication!.diagnostics().receipts).toBe(receipts + 2);
    await fixture.root.asyncCall("writeFile", ["/idle"], new Uint8Array([5]));
    const node = fixture.backend.fs.lookup("/idle")!;
    const handle = fixture.backend.fs.handleForNode(node);
    const domain = fixture.backend.shared.publication!,
      revision = fixture.backend.shared.revision(handle)!;
    expect(domain.contentVersion(node.ino)).toBe(1);
    expect(fixture.backend.shared.evict(handle, revision)).toBe(true);
    expect(domain.contentVersion(node.ino)).toBe(1);
    expect(await fixture.root.asyncCall("remove", ["/idle"])).toBe(true);
    expect(domain.contentVersion(node.ino)).toBe(0);
  } finally {
    fixture.stop();
  }
});

async function heldAdmissionWorker(root: FilesystemClient) {
  const worker = new Worker(new URL("./fixtures/publication-guest.ts", import.meta.url).href);
  const connection = root.fork();
  const gate = new Int32Array(new SharedArrayBuffer(4));
  let message = workerMessage(worker);
  worker.postMessage({ connection, mode: "wasi", admissionGate: gate.buffer }, [connection.port]);
  expect(await message).toEqual({ ready: true });
  message = workerMessage(worker);
  worker.postMessage({ operation: "write", byte: 88 });
  expect(await message).toEqual({ admissionHeld: true });
  return { worker, connection, gate };
}
function releaseAdmissionGate(gate: Int32Array): void {
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
}
test("production active admission remains fenced through live revocation without stealing", async () => {
  const fixture = await localPublicationFixture();
  const held = await heldAdmissionWorker(fixture.root);
  try {
    const start = await fixture.cut();
    const sections = Atomics.load(new Int32Array(held.connection.sections), 0);
    expect(fixture.sibling.tryWrite(fixture.handle, [new Uint8Array([7])], 0)).toBe(-6);
    let settled = false;
    const waiting = waitForFilesystemQuiescence(held.connection).then(() => {
      settled = true;
    });
    fixture.service.sweep();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const prematurelySettled = settled;
    const message = workerMessage(held.worker);
    releaseAdmissionGate(held.gate);
    expect(await message).toEqual({ result: 11, offset: 0, byte: 88, count: 0xdeadbeef });
    await waiting;
    fixture.service.sweep();
    expect(await fixture.cut()).toEqual(start);
    expect(fixture.sibling.tryWrite(fixture.handle, [new Uint8Array([9])], 0)).toBe(1);
    expect((await fixture.changes(start)).publications).toHaveLength(1);
    expect({ admitted: sections > 0, prematurelySettled }).toEqual({
      admitted: true,
      prematurelySettled: false,
    });
  } finally {
    releaseAdmissionGate(held.gate);
    held.worker.terminate();
    reapFilesystem(held.connection);
    fixture.stop();
  }
});
test("production proven-dead admission holder releases only its own arena for a live peer", async () => {
  const fixture = await localPublicationFixture();
  const held = await heldAdmissionWorker(fixture.root);
  try {
    const start = await fixture.cut();
    expect(fixture.sibling.tryWrite(fixture.handle, [new Uint8Array([7])], 0)).toBe(-6);
    revokeFilesystem(held.connection);
    const exited = new Promise<void>((resolve) => {
      held.worker.addEventListener("close", () => resolve(), { once: true });
    });
    held.worker.terminate();
    await exited;
    reapFilesystem(held.connection);
    fixture.service.sweep();
    const written = fixture.sibling.tryWrite(fixture.handle, [new Uint8Array([9])], 0);
    expect(written).toBe(1);
    expect((await fixture.changes(start)).publications).toHaveLength(1);
  } finally {
    releaseAdmissionGate(held.gate);
    held.worker.terminate();
    reapFilesystem(held.connection);
    fixture.root.shared.publication!.stop();
    fixture.stop();
  }
});

test("production append admits one EOF prefix and empty writes retain exact no-effect receipts", async () => {
  const fixture = await localPublicationFixture();
  try {
    const observer = publicationObserver(fixture.root);
    const before = await observer.cut();
    expect(fixture.sibling.tryAppend(fixture.handle, [new Uint8Array(128).fill(8)])).toEqual({
      written: 64, offset: 67,
    });
    const page = await observer.changes(before, limits.logBytes);
    requirePublicationGroups(page, 1);
    if (page.kind !== "changes") throw new Error("missing append group");
    expect(page.publications[0]!.receipt.result).toEqual({ kind: "append", written: 64, offset: 67 });
    expect(page.publications[0]!.changes[0]).toMatchObject({ kind: "bytes", offset: 3, size: 67 });
    const committed = await observer.cut();
    const admission = fixture.root[localPublication]("write", [fixture.handle, 0], new Uint8Array());
    if (admission.kind !== "admitted") throw new Error("missing empty-write identity");
    expect(await fixture.root.asyncCall("write", [fixture.handle, 0], admission.input, admission.admission)).toBe(0);
    const lookup = await observer.receipt(admission.admission.id);
    expect(lookup).toMatchObject({ kind: "committed", receipt: { cut: committed, result: { kind: "number", value: 0 } } });
    expect(fixture.root[localPublication]("write", [fixture.handle, 0], new Uint8Array(), admission.admission.id).kind).toBe("duplicate");
    expect(await observer.cut()).toEqual(committed);
    oracleCurrent([fixture.root, fixture.sibling], fixture.handle, [1, 2, 3].concat(Array(64).fill(8)));
  } finally {
    fixture.stop();
  }
});

test("production cancelled after-commit value cannot install a late observer cursor", async () => {
  const fixture = await localPublicationFixture();
  const post = fixture.server.port.postMessage.bind(fixture.server.port);
  const held = deferred();
  let target = -1;
  let late: unknown;
  fixture.server.port.postMessage = (message: unknown) => {
    if (message && typeof message === "object" && "completed" in message && message.completed === target) {
      late = message;
      held.resolve();
      return;
    }
    post(message);
  };
  try {
    const observer = publicationObserver(fixture.root);
    let cursor = await observer.cut();
    const before = cursor;
    const completion = fixture.root.submit("publicationCut", [fixture.grant]);
    target = completion.id;
    const value = completion.value().then((cut) => { cursor = cut; });
    await held.promise;
    await expectErrno(observer.stop(), 11);
    await expectErrno(value, 11);
    completion.release();
    post(late);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cursor).toEqual(before);
    expect(fixture.root.completions.size).toBe(0);
    expect(fixture.sibling.tryRead(fixture.handle, [new Uint8Array(3)], 0)).toBe(-11);
    expect(fixture.sibling.tryWrite(fixture.handle, [new Uint8Array([9])], 0)).toBe(-11);
    expect(() => fixture.sibling.fork()).toThrow();
    expect(fixture.backend.shared.publication!.diagnostics()).toMatchObject({ stopped: true, pending: 0, pins: 0, inputBytes: 0 });
  } finally {
    fixture.server.port.postMessage = post;
    fixture.stop();
  }
});

test("production closed sessions cannot be resurrected by a fresh connection", async () => {
  const fixture = await localPublicationFixture();
  let fresh: FilesystemClient | undefined;
  try {
    const old = fixture.sibling.connection.publication!.session;
    const id = fixture.sibling.shared.publication!.next(old);
    fixture.sibling.dispose();
    fixture.service.sweep();
    fresh = new FilesystemClient(fixture.root.fork());
    expect(fresh.connection.publication!.session.serial).not.toBe(old.serial);
    const cut = await fixture.cut();
    expect(() => fresh![localPublication]("write", [fixture.handle, 0], new Uint8Array([9]), id)).toThrow();
    expect(() => fresh!.shared.publication!.admit(old, id, { kind: "write", handle: fixture.handle, offset: 0 }, new Uint8Array([9]))).toThrow("closed");
    expect(await fixture.cut()).toEqual(cut);
  } finally {
    fresh?.dispose();
    fixture.stop();
  }
});
