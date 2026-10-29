import { SharedFilesystem } from "../browser/shared-fs.js";
import {
  FilesystemClient,
  type FilesystemCompletion,
  createFilesystemConnection,
  createFilesystemIdentity,
  connectFilesystemIdentity,
  revokeFilesystem,
  reapFilesystem,
  waitForFilesystemQuiescence,
} from "../fs/index.js";
import {
  localPublication,
  publicationObserver,
  type PublicationLimits,
} from "../fs/publication-internal.js";
import { SLOT_WORDS } from "../fs/shared.js";
import { PAGE, type FilesystemConnection } from "../fs/protocol.js";
import type { PublicationCut } from "../fs/publication.js";

const limits: PublicationLimits = {
  sessions: 8,
  operations: 16,
  inputBytes: 64,
  argumentBytes: 1024,
  effectBytes: 8192,
  effects: 32,
  resultBytes: 128,
  logRecords: 16,
  logBytes: 131072,
  pins: 2,
  pinBytes: 128,
};
function equal(actual: unknown, expected: unknown): void {
  const canonical = (value: unknown) =>
    JSON.stringify(value, (_key, item: unknown) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
        : item,
    );
  if (canonical(actual) !== canonical(expected))
    throw new Error(`Expected ${canonical(expected)}, received ${canonical(actual)}`);
}
function field(value: unknown, key: string): unknown {
  if (value && typeof value === "object" && key in value) return Reflect.get(value, key);
  throw new Error(`Missing ${key} in ${JSON.stringify(value)}`);
}
async function denied(action: Promise<unknown>, errno: number): Promise<void> {
  let failure: unknown;
  try {
    await action;
  } catch (error) {
    failure = error;
  }
  equal(field(failure, "errno"), errno);
}
function throws(action: () => unknown): void {
  let caught = false;
  try {
    action();
  } catch {
    caught = true;
  }
  equal(caught, true);
}
function response(worker: Worker): Promise<unknown> {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data?.failure) reject(new Error(data.failure));
      else resolve(data);
    };
    worker.onerror = (event) => reject(new Error(event.message));
    worker.onmessageerror = () => reject(new Error("Invalid publication worker response"));
  });
}
function message(worker: Worker, value: unknown, transfer: Transferable[] = []): Promise<unknown> {
  const pending = response(worker);
  worker.postMessage(value, transfer);
  return pending;
}
// Delay native request delivery until the real completion waiter is registered.
function holdRequest(client: FilesystemClient, submit: () => FilesystemCompletion) {
  const port = client.connection.port;
  const post = port.postMessage.bind(port);
  let send: (() => void) | undefined;
  port.postMessage = (request: unknown) => {
    if (send) throw new Error("Expected one held request");
    send = () => post(request);
  };
  try {
    const completion = submit();
    if (!send) throw new Error("Missing held request");
    return { completion, send };
  } finally {
    port.postMessage = post;
  }
}
interface WorkerOwner {
  readonly worker: Worker;
  readonly connection: FilesystemConnection;
  readonly url: string;
  readonly gate?: Int32Array;
  dead: boolean;
}
async function physicalStop(owner: WorkerOwner): Promise<void> {
  if (owner.dead) return;
  const observe = Reflect.get(globalThis, "__publicationWaitForClose");
  if (typeof observe !== "function")
    throw new Error("Native browser worker-close observer missing");
  const closed = observe(owner.url);
  owner.worker.terminate();
  await closed;
  owner.dead = true;
}
function releaseGate(gate?: Int32Array): void {
  if (!gate) return;
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
}
async function memoryFixture(overrides: Partial<PublicationLimits> = {}) {
  const config = { ...limits, ...overrides };
  const fs = new SharedFilesystem({
    mode: "memory",
    workerURL: "/fs-worker.js",
    [localPublication]: { limits: config, observe: true },
  });
  const owners: WorkerOwner[] = [];
  try {
    await fs.writeFile("/file", new Uint8Array([1, 2, 3]));
    const directory: number = await fs.client.asyncCall("preopen", ["/"]);
    const path: { node: number } = await fs.client.asyncCall("resolve", [directory, "file"]);
    fs.client.retain(path.node);
    const observer = publicationObserver(fs.client);
    const spawn = async (mode: "wasi" | "proc", gate?: Int32Array) => {
      const url = new URL(`/guest.js?identity=${crypto.randomUUID()}`, location.href).href;
      const owner: WorkerOwner = {
        url,
        worker: new Worker(url, { type: "module" }),
        connection: fs.fork(),
        gate,
        dead: false,
      };
      owners.push(owner);
      equal(owner.connection.publication?.observer, undefined);
      equal(
        await message(
          owner.worker,
          { connection: owner.connection, mode, admissionGate: gate?.buffer },
          [owner.connection.port],
        ),
        { ready: true },
      );
      return owner;
    };
    const stop = () => stopOwners(owners, fs);
    return { fs, client: fs.client, observer, handle: path.node, directory, config, spawn, stop };
  } catch (error) {
    await fs.dispose();
    throw error;
  }
}
async function stopOwners(owners: readonly WorkerOwner[], fs: SharedFilesystem): Promise<void> {
  for (const owner of owners) releaseGate(owner.gate);
  for (const owner of owners) {
    await physicalStop(owner);
    fs.reap(owner.connection);
  }
  await fs.dispose();
}
type Fixture = Awaited<ReturnType<typeof memoryFixture>>;
async function group(f: Fixture, before: PublicationCut, kinds?: readonly string[]) {
  const immediate = f.client.shared.current(true, undefined, f.client.connection.owner, () => {
    const domain = f.client.shared.publication!;
    const page = domain.changes(before, f.config.logBytes);
    if (page.kind !== "changes") throw new Error("Missing synchronous publication group");
    equal(page.publications.length, 1);
    const publication = page.publications[0]!;
    if (kinds)
      equal(
        publication.changes.map((effect) => effect.kind),
        kinds,
      );
    equal(domain.lookupAny(publication.receipt.id), {
      kind: "committed",
      receipt: publication.receipt,
    });
    return publication.receipt;
  });
  const page = await f.observer.changes(before, f.config.logBytes);
  if (page.kind !== "changes") throw new Error("Unexpected publication gap");
  equal(page.publications.length, 1);
  const publication = page.publications[0]!;
  equal(publication.receipt, immediate);
  equal(publication.receipt.cut, { history: before.history, generation: before.generation + 1 });
  equal(await f.observer.receipt(publication.receipt.id), {
    kind: "committed",
    receipt: publication.receipt,
  });
  equal(publication.receipt.durability, { kind: "untracked" });
  if (kinds)
    equal(
      publication.changes.map((effect) => effect.kind),
      kinds,
    );
  equal(await f.observer.cut(), publication.receipt.cut);
  return publication;
}
async function current(
  f: Fixture,
  owners: readonly WorkerOwner[],
  expected: readonly number[],
): Promise<void> {
  equal(Array.from((await f.fs.readFile("/file"))!), expected);
  const bytes = new Uint8Array(expected.length);
  equal(f.client.tryRead(f.handle, [bytes], 0), expected.length);
  equal(Array.from(bytes), expected);
  for (const owner of owners)
    equal(await message(owner.worker, { operation: "inspect", byte: 42 }), {
      result: expected.length,
      bytes: expected,
    });
}
async function writerOracle(): Promise<void> {
  const f = await memoryFixture();
  try {
    const wasi = await f.spawn("wasi"),
      proc = await f.spawn("proc"),
      direct = await f.spawn("proc");
    const owners = [wasi, proc, direct];
    let before = await f.observer.cut();
    const source = new Uint8Array([7, 6, 5]);
    const write = f.fs.writeFile("/file", source);
    source.fill(99);
    await write;
    await group(f, before, ["bytes", "metadata"]);
    await current(f, owners, [7, 6, 5]);
    before = await f.observer.cut();
    equal(await message(wasi.worker, { operation: "write", byte: 8 }), {
      result: 0,
      offset: 0,
      byte: 8,
      count: 1,
    });
    await group(f, before, ["bytes", "metadata"]);
    await current(f, owners, [8, 6, 5]);
    before = await f.observer.cut();
    equal(await message(direct.worker, { operation: "directWrite", byte: 9 }), 1);
    await group(f, before, ["bytes", "metadata"]);
    await current(f, owners, [9, 6, 5]);
    before = await f.observer.cut();
    equal(await message(wasi.worker, { operation: "offsetWrite", byte: 4 }), {
      result: 0,
      offset: 1,
      byte: 4,
      count: 1,
    });
    await group(f, before, ["bytes", "metadata"]);
    await current(f, owners, [4, 6, 5]);
    before = await f.observer.cut();
    equal(await message(proc.worker, { operation: "write", byte: 3 }), {
      result: 1,
      offset: 1,
      byte: 3,
      count: 0xdeadbeef,
    });
    await group(f, before, ["bytes", "metadata"]);
    await current(f, owners, [3, 6, 5]);
    before = await f.observer.cut();
    equal(await message(direct.worker, { operation: "directAppend", byte: 2 }), {
      written: 1,
      offset: 4,
    });
    // No publication nudge exists. Real completion/segment delivery remains enabled.
    await group(f, before, ["bytes", "metadata"]);
    await current(f, owners, [3, 6, 5, 2]);
  } finally {
    await f.stop();
  }
}
async function contention(owner: WorkerOwner, cells: Int32Array, lock: number): Promise<void> {
  Atomics.store(cells, lock, 99);
  try {
    equal(await message(owner.worker, { operation: "write", byte: 10 }), {
      result: -6,
      offset: 0,
      byte: 10,
      count: 0xdeadbeef,
    });
    equal(await message(owner.worker, { operation: "read", byte: 42 }), {
      result: -6,
      offset: 0,
      byte: 42,
      count: 0xdeadbeef,
    });
  } finally {
    Atomics.store(cells, lock, 0);
  }
}
async function nonblocking(): Promise<void> {
  const f = await memoryFixture();
  try {
    const owner = await f.spawn("proc");
    const before = await f.observer.cut();
    await contention(owner, f.client.shared.cells, 1);
    await contention(
      owner,
      f.client.shared.slots,
      f.client.shared.fileSlot(f.handle) * SLOT_WORDS + 8,
    );
    equal(await f.observer.cut(), before);
    equal(f.client.tryWrite(f.handle, [new Uint8Array(128).fill(8)], 0), 64);
    const publication = await group(f, before, ["bytes", "metadata"]);
    equal(publication.receipt.result, { kind: "number", value: 64 });
    let cut = await f.observer.cut();
    equal(f.client.tryAppend(f.handle, [new Uint8Array(128).fill(9)]), {
      written: 64,
      offset: 128,
    });
    const append = await group(f, cut, ["bytes", "metadata"]);
    equal(append.receipt.result, { kind: "append", written: 64, offset: 128 });
    cut = await f.observer.cut();
    const empty = f.client[localPublication]("write", [f.handle, 0], new Uint8Array());
    if (empty.kind !== "admitted") throw new Error("Missing empty-write identity");
    equal(await f.client.asyncCall("write", [f.handle, 0], empty.input, empty.admission), 0);
    const receipt = await f.observer.receipt(empty.admission.id);
    equal(field(receipt, "kind"), "committed");
    equal(field(field(receipt, "receipt"), "cut"), cut);
    equal(field(field(receipt, "receipt"), "result"), { kind: "number", value: 0 });
    equal(f.client.tryAppend(f.handle, []), { written: 0, offset: 128 });
    equal(await f.observer.cut(), cut);
    await denied(f.client.asyncCall("writeFile", ["/file"], new Uint8Array(65)), 6);
    equal(await f.observer.cut(), cut);
    equal((await f.fs.readFile("/file"))!.length, 128);
    await denied(f.client.asyncCall("writeFile", ["/file", false, true], new Uint8Array([1])), 20);
    equal(await f.observer.cut(), cut);
  } finally {
    await f.stop();
  }
}
async function growth(): Promise<void> {
  const f = await memoryFixture();
  try {
    const before = await f.observer.cut(),
      revision = f.client.shared.revision(f.handle);
    const bytes = new Uint8Array([8]);
    equal(f.client.tryWrite(f.handle, [bytes], PAGE), -6);
    bytes[0] = 9;
    const pending = Array.from(f.client.completions.values());
    equal(pending.length, 1);
    await pending[0]!.value();
    equal(await f.observer.cut(), before);
    equal(f.client.shared.revision(f.handle), revision);
    equal(f.client.stat(f.handle).size, 3);
    equal(f.client.tryWrite(f.handle, [bytes], PAGE), 1);
    await group(f, before, ["bytes", "metadata"]);
    const output = new Uint8Array(1);
    equal(f.client.tryRead(f.handle, [output], PAGE), 1);
    equal(Array.from(output), [9]);
    equal(field(await f.observer.diagnostics(), "pending"), 0);
    equal(await f.client.asyncCall("resize", [f.handle, PAGE * 2, false]), 0);
    const appendCut = await f.observer.cut(),
      appendRevision = f.client.shared.revision(f.handle);
    const ownedBefore = (await f.observer.diagnostics()).inputBytes;
    bytes[0] = 10;
    equal(f.client.tryAppend(f.handle, [bytes]), -6);
    equal((await f.observer.diagnostics()).inputBytes, ownedBefore);
    bytes[0] = 11;
    const appendPreparation = Array.from(f.client.completions.values());
    equal(appendPreparation.length, 1);
    await appendPreparation[0]!.value();
    equal(await f.observer.cut(), appendCut);
    equal(f.client.shared.revision(f.handle), appendRevision);
    equal(f.client.stat(f.handle).size, PAGE * 2);
    equal(f.client.tryAppend(f.handle, [bytes]), { written: 1, offset: PAGE * 2 + 1 });
    await group(f, appendCut, ["bytes", "metadata"]);
    equal(f.client.tryRead(f.handle, [output], PAGE * 2), 1);
    equal(Array.from(output), [11]);
  } finally {
    await f.stop();
  }
}
async function hostOperations(): Promise<void> {
  const f = await memoryFixture();
  try {
    let before = await f.observer.cut();
    await f.fs.writeFile("/file", new Uint8Array([8, 9]));
    await group(f, before, ["resize", "bytes", "metadata"]);
    equal(Array.from((await f.fs.readFile("/file"))!), [8, 9]);
    before = await f.observer.cut();
    await f.fs.writeFile("/file", new Uint8Array([7]), true);
    const appended = await group(f, before, ["bytes", "metadata"]);
    equal(field(appended.changes[0], "offset"), 2);
    equal(Array.from((await f.fs.readFile("/file"))!), [8, 9, 7]);
    before = await f.observer.cut();
    await f.fs.writeFile("/new/child", new Uint8Array([6]), { exclusive: true });
    const created = await group(f, before);
    equal(created.changes.filter((effect) => effect.kind === "inode").length, 2);
    equal(created.changes.filter((effect) => effect.kind === "entry").length, 2);
    equal(Array.from((await f.fs.readFile("/new/child"))!), [6]);
    before = await f.observer.cut();
    await denied(f.fs.writeFile("/new/child", new Uint8Array([99]), { exclusive: true }), 20);
    await denied(f.fs.drain(), 20);
    equal(await f.observer.cut(), before);
    equal(Array.from((await f.fs.readFile("/new/child"))!), [6]);
    await f.fs.move("/new/child", "/new/moved");
    await group(f, before);
    equal(await f.fs.listFiles(), ["/file", "/new/moved"]);
  } finally {
    await f.stop();
  }
}
async function namespace(): Promise<void> {
  const f = await memoryFixture();
  try {
    const resolve = (name: string): Promise<{ node: number }> =>
      f.client.asyncCall("resolve", [f.directory, name]);
    let before = await f.observer.cut();
    const parent: number = await f.client.asyncCall("preopen", ["/tree/child"]);
    f.client.retain(parent);
    const made = await group(f, before);
    equal(
      made.changes.filter((effect) => effect.kind === "entry").map((effect) => effect.name),
      ["tree", "child"],
    );
    before = await f.observer.cut();
    const targetPath = await resolve("target");
    const target: number = await f.client.asyncCall("create", [targetPath, "file", true]);
    f.client.retain(target);
    await group(f, before, ["inode", "entry", "metadata"]);
    await f.client.asyncCall("grow", [target, 3]);
    before = await f.observer.cut();
    equal(await f.client.asyncCall("rename", [await resolve("file"), await resolve("target")]), 0);
    const renamed = await group(f, before);
    equal(renamed.changes.filter((effect) => effect.kind === "entry").length, 2);
    equal(f.client.tryWrite(f.handle, [new Uint8Array([8])], 0), 1);
    equal(f.client.tryWrite(target, [new Uint8Array([9])], 0), 1);
    before = await f.observer.cut();
    equal(await f.client.asyncCall("link", [await resolve("target"), await resolve("alias")]), 0);
    await group(f, before, ["entry", "metadata"]);
    equal((await resolve("alias")).node, f.handle);
    before = await f.observer.cut();
    equal(await f.client.asyncCall("removePath", [await resolve("target"), false]), 0);
    await group(f, before, ["entry", "metadata"]);
    before = await f.observer.cut();
    await f.fs.move("/alias", "/moved");
    await group(f, before);
    before = await f.observer.cut();
    equal(await f.fs.remove("/moved"), true);
    await group(f, before);
    const source = new Uint8Array(3),
      overwritten = new Uint8Array(1);
    equal(f.client.tryRead(f.handle, [source], 0), 3);
    equal(f.client.tryRead(target, [overwritten], 0), 1);
    equal(Array.from(source), [8, 2, 3]);
    equal(Array.from(overwritten), [9]);
    equal(f.client.stat(f.handle).ino === f.client.stat(target).ino, false);
    before = await f.observer.cut();
    equal(await f.fs.remove("/tree"), true);
    const removed = await group(f, before);
    equal(
      removed.changes
        .filter((effect) => effect.kind === "entry")
        .map((effect) => effect.name)
        .sort(),
      ["child", "tree"],
    );
    equal(await f.fs.listFiles(), []);
    before = await f.observer.cut();
    equal(await f.fs.remove("/tree"), false);
    await f.fs.mkdirp("/new/deep");
    await group(f, before);
    equal(
      (await f.client.asyncCall("readdir", [f.directory])).map(
        (entry: { name: string }) => entry.name,
      ),
      [".", "..", "new"],
    );
    equal(
      await f.client.asyncCall("create", [
        await f.client.asyncCall("resolve", [parent, "lost"]),
        "file",
        true,
      ]),
      { error: 44 },
    );
  } finally {
    await f.stop();
  }
}
async function metadataAndReads(): Promise<void> {
  const f = await memoryFixture();
  try {
    let before = await f.observer.cut();
    equal(f.client.resize(f.handle, 6, false), 0);
    await group(f, before, ["resize"]);
    equal(f.client.stat(f.handle).size, 6);
    before = await f.observer.cut();
    equal(f.client.setMtime(f.handle, 77), 0);
    await group(f, before, ["metadata"]);
    before = await f.observer.cut();
    equal(await f.client.asyncCall("resize", [f.handle, 3, true]), 0);
    await group(f, before, ["resize", "metadata"]);
    before = await f.observer.cut();
    equal(await f.client.asyncCall("setMtime", [f.handle, 88]), 0);
    await group(f, before, ["metadata"]);
    const ino = f.client.stat(f.handle).ino;
    equal(await f.client.asyncCall("setMode", [f.handle, 0o400]), 0);
    const deniedCut = await f.observer.cut();
    equal(f.client.tryWrite(f.handle, [new Uint8Array([9])], 0), -2);
    equal(f.client.permissions(f.handle)?.access, 4);
    await denied(f.client.asyncCall("write", [f.handle, 0], new Uint8Array([9])), 2);
    equal(await f.observer.cut(), deniedCut);
    equal(await f.client.asyncCall("setMode", [f.handle, 0o600]), 0);
    equal(f.client.stat(f.handle).ino, ino);
    await f.fs.writeFile("/dir/file", new Uint8Array([4]));
    const parent: number = await f.client.asyncCall("preopen", ["/dir"]);
    f.client.retain(parent);
    equal((await f.client.asyncCall("lookup", ["/dir"])).children.size, 1);
    equal(await f.client.asyncCall("setMode", [parent, 0o600]), 0);
    equal(await f.client.asyncCall("resolve", [parent, "file"]), 2);
    await denied(f.client.asyncCall("readFile", ["/dir/file"]), 2);
    await denied(f.client.asyncCall("listFiles", ["/dir"]), 2);
    equal(await f.client.asyncCall("setMode", [parent, 0o700]), 0);
    equal(Array.from((await f.fs.readFile("/dir/file"))!), [4]);
    await denied(f.client.asyncCall("mkdirp", ["/a/b/c/d/e/f/g/h/i/j/k/l"]), 6);
    equal(await f.client.asyncCall("lookup", ["/a"]), undefined);
  } finally {
    await f.stop();
  }
}
async function identitiesAndPins(): Promise<void> {
  const f = await memoryFixture({ logRecords: 2, logBytes: 16384 });
  try {
    const before = await f.observer.cut();
    const args = [f.handle, 0],
      bytes = new Uint8Array([8]);
    const admitted = f.client[localPublication]("write", args, bytes);
    if (admitted.kind !== "admitted") throw new Error("Expected identity");
    equal(await f.client.asyncCall("write", args, admitted.input, admitted.admission), 1);
    const entry = await group(f, before, ["bytes", "metadata"]);
    equal(f.client[localPublication]("write", args, bytes, admitted.admission.id), {
      kind: "duplicate",
      receipt: entry.receipt,
    });
    for (const request of [
      () => f.client[localPublication]("write", args, new Uint8Array([9]), admitted.admission.id),
      () => f.client[localPublication]("write", [f.handle, 1], bytes, admitted.admission.id),
      () => f.client[localPublication]("write", [999, 0], bytes, admitted.admission.id),
      () => f.client[localPublication]("append", [f.handle], bytes, admitted.admission.id),
    ])
      throws(request);
    const pin = await f.observer.pin(f.handle, 0, 3);
    equal(pin.bytes, [8, 2, 3]);
    const second = await f.observer.pin(f.handle, 0, 3);
    await denied(f.observer.pin(f.handle, 0, 3), 6);
    await f.observer.releasePin(second.id);
    equal(f.client.tryWrite(f.handle, [new Uint8Array([9])], 0), 1);
    const newer = await f.observer.pin(f.handle, 0, 3);
    equal(newer.bytes, [9, 2, 3]);
    equal(newer.version, pin.version + 1);
    equal(pin.bytes, [8, 2, 3]);
    await f.observer.releasePin(pin.id);
    await f.observer.releasePin(newer.id);
    equal((await f.observer.diagnostics()).pins, 0);
    for (let index = 0; index < limits.operations; index++)
      await f.client.asyncCall("setMtime", [f.handle, index + 100]);
    equal(await f.observer.receipt(admitted.admission.id), { kind: "retired" });
    throws(() => f.client[localPublication]("write", args, bytes, admitted.admission.id));
    equal((await f.observer.changes(before, f.config.logBytes)).kind, "gap");
    const fork = new FilesystemClient(f.fs.fork());
    try {
      await denied(
        fork.asyncCall("publicationCut", [f.client.connection.publication?.observer]),
        2,
      );
    } finally {
      fork.dispose();
    }
    await closedSession(f);
  } finally {
    await f.stop();
  }
}
async function closedSession(f: Fixture): Promise<void> {
  const old = new FilesystemClient(f.fs.fork());
  const session = old.connection.publication!.session;
  const id = old.shared.publication!.next(session);
  old.dispose();
  const before = await f.observer.cut();
  // The next request runs after the cut's trailing service sweep.
  equal((await f.observer.diagnostics()).sessions, 1);
  const fresh = new FilesystemClient(f.fs.fork());
  try {
    equal(fresh.connection.publication!.session.serial === session.serial, false);
    throws(() => fresh[localPublication]("write", [f.handle, 0], new Uint8Array([9]), id));
    throws(() =>
      fresh.shared.publication!.admit(
        session,
        id,
        { kind: "write", handle: f.handle, offset: 0 },
        new Uint8Array([9]),
      ),
    );
    equal(await f.observer.cut(), before);
  } finally {
    fresh.dispose();
  }
}
async function liveAdmission(): Promise<void> {
  const f = await memoryFixture();
  const gate = new Int32Array(new SharedArrayBuffer(4));
  try {
    const held = await f.spawn("wasi", gate);
    const before = await f.observer.cut();
    equal(await message(held.worker, { operation: "write", byte: 88 }), { admissionHeld: true });
    equal(Atomics.load(new Int32Array(held.connection.sections), 0) > 0, true);
    equal(f.client.tryWrite(f.handle, [new Uint8Array([7])], 0), -6);
    let settled = false;
    const quiesced = waitForFilesystemQuiescence(held.connection).then(() => {
      settled = true;
    });
    await Promise.resolve();
    equal(settled, false);
    const finished = response(held.worker);
    releaseGate(gate);
    equal(await finished, { result: 11, offset: 0, byte: 88, count: 0xdeadbeef });
    await quiesced;
    equal(await f.observer.cut(), before);
    // Request completion precedes service sweep; observe retirement before testing the live peer.
    equal((await f.observer.diagnostics()).sessions, 1);
    equal(f.client.tryWrite(f.handle, [new Uint8Array([9])], 0), 1);
    await group(f, before, ["bytes", "metadata"]);
  } finally {
    releaseGate(gate);
    await f.stop();
  }
}
async function deadAdmission(): Promise<void> {
  const f = await memoryFixture();
  const gate = new Int32Array(new SharedArrayBuffer(4));
  try {
    const held = await f.spawn("wasi", gate);
    const before = await f.observer.cut();
    equal(await message(held.worker, { operation: "write", byte: 88 }), { admissionHeld: true });
    equal(f.client.tryWrite(f.handle, [new Uint8Array([7])], 0), -6);
    revokeFilesystem(held.connection);
    await physicalStop(held);
    f.fs.reap(held.connection);
    // Let the actual filesystem worker observe the reaped owner before the peer retry.
    await f.observer.cut();
    equal(f.client.tryWrite(f.handle, [new Uint8Array([9])], 0), 1);
    await group(f, before, ["bytes", "metadata"]);
  } finally {
    releaseGate(gate);
    await f.stop();
  }
}

async function serviceFixture(cold: boolean) {
  const connection = createFilesystemConnection(undefined, { limits, observe: true });
  const url = new URL(`/guest.js?service=${crypto.randomUUID()}`, location.href).href;
  const owner: WorkerOwner = {
    url,
    worker: new Worker(url, { type: "module" }),
    connection: connection.server,
    dead: false,
  };
  const client = new FilesystemClient(connection.client);
  let sibling: FilesystemClient | undefined;
  try {
    equal(
      await message(owner.worker, { connection: connection.server, mode: "service", cold }, [
        connection.server.port,
      ]),
      { ready: true },
    );
    const directory: number = await client.asyncCall("preopen", ["/"]);
    const path: { node: number } = await client.asyncCall("resolve", [directory, "file"]);
    client.retain(path.node);
    const identity = createFilesystemIdentity(client.connection);
    const pair = connectFilesystemIdentity(identity, connection.pool);
    await message(owner.worker, { connect: pair.server }, [pair.server.port]);
    sibling = new FilesystemClient(pair.client);
    const peerDir: number = await sibling.asyncCall("preopen", ["/"]);
    const peerPath: { node: number } = await sibling.asyncCall("resolve", [peerDir, "file"]);
    sibling.retain(peerPath.node);
    const stop = async () => {
      await physicalStop(owner);
      reapFilesystem(connection.client);
      sibling?.dispose();
      client.dispose();
    };
    return {
      client,
      sibling,
      handle: path.node,
      owner,
      observer: publicationObserver(client),
      stop,
    };
  } catch (error) {
    await physicalStop(owner);
    sibling?.dispose();
    client.dispose();
    throw error;
  }
}
async function coldStop(): Promise<void> {
  const f = await serviceFixture(true);
  try {
    const reading = response(f.owner.worker);
    const loading = denied(f.observer.pin(f.handle, 0, 3), 11);
    const output = new Uint8Array(3).fill(42);
    equal(f.client.tryRead(f.handle, [output], 0), -6);
    equal(await reading, { reading: true });
    await denied(f.observer.stop(), 11);
    const state = await message(f.owner.worker, { control: "releaseLoad" });
    await loading;
    equal(field(state, "hydrations"), 0);
    equal(field(state, "resident"), false);
    equal(field(field(state, "diagnostics"), "stopped"), true);
    equal(field(field(state, "diagnostics"), "pending"), 0);
    equal(field(field(state, "diagnostics"), "pins"), 0);
    equal(field(field(state, "diagnostics"), "inputBytes"), 0);
    equal(Array.from(output), [42, 42, 42]);
    equal(f.client.tryRead(f.handle, [output], 0), -11);
    equal(f.sibling.tryWrite(f.handle, [new Uint8Array([9])], 0), -11);
  } finally {
    await f.stop();
  }
}
async function coldPeer(): Promise<void> {
  const f = await serviceFixture(true);
  try {
    const before = await f.observer.cut();
    const reading = response(f.owner.worker);
    equal(f.sibling.tryWrite(f.handle, [new Uint8Array([8])], 0), -6);
    equal(f.client.tryRead(f.handle, [new Uint8Array(3)], 0), -6);
    equal(await reading, { reading: true });
    f.sibling.dispose();
    const state = await message(f.owner.worker, { control: "releaseLoad" });
    equal(field(state, "hydrations"), 1);
    equal(field(state, "resident"), true);
    for (const completion of Array.from(f.client.completions.values())) await completion.value();
    const output = new Uint8Array(3);
    equal(f.client.tryRead(f.handle, [output], 0), 3);
    equal(Array.from(output), [1, 2, 3]);
    equal(await f.observer.cut(), before);
    equal((await f.observer.diagnostics()).inputBytes, 0);
  } finally {
    await f.stop();
  }
}
async function responseLoss(): Promise<void> {
  const f = await serviceFixture(false);
  try {
    const before = await f.observer.cut();
    const args = [f.handle, 0],
      bytes = new Uint8Array([9]);
    const admitted = f.client[localPublication]("write", args, bytes);
    if (admitted.kind !== "admitted") throw new Error("Expected admission");
    await message(f.owner.worker, { control: "holdResponse", id: -2 });
    const held = response(f.owner.worker);
    const { completion, send } = holdRequest(f.client, () =>
      f.client.submit("write", args, admitted.input, undefined, admitted.admission),
    );
    equal(completion.ready, false);
    const value = completion.value();
    const rejected = denied(value, 11);
    send();
    equal(await held, { responseHeld: true });
    const receipt = await f.observer.receipt(admitted.admission.id);
    if (receipt.kind !== "committed") throw new Error("Lost response lost the receipt");
    equal(receipt.receipt.result, { kind: "number", value: 1 });
    equal(receipt.receipt.cut.generation, before.generation + 1);
    completion.cancel();
    await rejected;
    completion.release();
    await message(f.owner.worker, { control: "deliverResponse" });
    equal(
      f.client[localPublication]("write", args, bytes, admitted.admission.id).kind,
      "duplicate",
    );
    const page = await f.observer.changes(before, limits.logBytes);
    if (page.kind !== "changes") throw new Error("Lost receipt log");
    equal(page.publications.length, 1);
    equal(
      page.publications[0]!.changes.map((effect) => effect.kind),
      ["bytes", "metadata"],
    );
    equal(f.client.completions.size, 0);
  } finally {
    await f.stop();
  }
}
async function lateStoppedReply(): Promise<void> {
  const f = await serviceFixture(false);
  try {
    let cursor = await f.observer.cut();
    const before = cursor;
    await message(f.owner.worker, { control: "holdResponse", id: -2 });
    const held = response(f.owner.worker);
    const { completion, send } = holdRequest(f.client, () =>
      f.client.submit("publicationCut", [f.client.connection.publication?.observer]),
    );
    equal(completion.ready, false);
    const value = completion.value().then((cut) => {
      cursor = cut;
    });
    const rejected = denied(value, 11);
    send();
    equal(await held, { responseHeld: true });
    await denied(f.observer.stop(), 11);
    await rejected;
    completion.release();
    await message(f.owner.worker, { control: "deliverResponse" });
    equal(cursor, before);
    equal(f.client.completions.size, 0);
    await denied(f.observer.cut(), 11);
    throws(() => f.client.fork());
    equal(f.sibling.tryRead(f.handle, [new Uint8Array(3)], 0), -11);
  } finally {
    await f.stop();
  }
}
async function sensitivity(): Promise<void> {
  const f = await memoryFixture({ logRecords: 2, logBytes: 16384 });
  const domain = f.client.shared.publication!,
    commit = domain.commit.bind(domain);
  try {
    const before = await f.observer.cut();
    domain.commit = (prepared) => prepared.receipt;
    equal(f.client.tryWrite(f.handle, [new Uint8Array([9])], 0), 1);
    const page = await f.observer.changes(before, f.config.logBytes);
    equal(page.kind, "changes");
    equal(field(page, "publications"), []);
    let rejected = false;
    try {
      await group(f, before, ["bytes", "metadata"]);
    } catch {
      rejected = true;
    }
    equal(rejected, true);
    domain.commit = commit;
    for (const byte of [6, 7, 8])
      equal(f.client.tryWrite(f.handle, [new Uint8Array([byte])], 0), 1);
    equal((await f.observer.changes(before, f.config.logBytes)).kind, "gap");
  } finally {
    domain.commit = commit;
    await f.stop();
  }
}
async function uninstrumented(): Promise<void> {
  const fs = new SharedFilesystem({ mode: "memory", workerURL: "/fs-worker.js" });
  try {
    await fs.writeFile("/ordinary", "plain");
    equal(fs.client.connection.publication, undefined);
    equal(fs.client.shared.publication, undefined);
    equal(Array.from((await fs.readFile("/ordinary"))!), [112, 108, 97, 105, 110]);
  } finally {
    await fs.dispose();
  }
}
/** @browserEntry Executed by the registered browser runner through its bundled URL. */
export async function runPublicationBrowser(): Promise<string[]> {
  const cases: readonly [string, () => Promise<void>][] = [
    ["uninstrumented root allocates no publication domain", uninstrumented],
    [
      "host real WASI runtime_proc and resident writers publish receipts and current reads without nudges",
      writerOracle,
    ],
    [
      "global and file contention preserve guest memory and offsets; one bounded prefix and no delayed suffix",
      nonblocking,
    ],
    ["growth owns no guest bytes or logical revision before retry", growth],
    [
      "host replace append exclusive create and move each publish one complete group",
      hostOperations,
    ],
    [
      "namespace groups retain distinct inode identities across rename link unlink and recursive removal",
      namespace,
    ],
    ["direct and service metadata plus cached current reads enforce permissions", metadataAndReads],
    [
      "exact duplicate conflicts retirement immutable pins and explicit history gaps",
      identitiesAndPins,
    ],
    ["live admission revocation waits without stealing from the holder", liveAdmission],
    [
      "native browser worker close is observed before reaping the dead admission holder",
      deadAdmission,
    ],
    ["actual paused PersistentBackend read cannot hydrate after domain stop", coldStop],
    ["cancelled cold writer preserves a live peer sharing the actual storage read", coldPeer],
    ["after-commit response loss preserves receipt and exact duplicate result", responseLoss],
    ["stopped authority rejects a late reply without installing an old cursor", lateStoppedReply],
    ["oracle detects missing direct publication and a stale retained cut", sensitivity],
  ];
  const passed: string[] = [];
  for (const [name, run] of cases) {
    console.log(`publication control: ${name}`);
    try {
      await run();
    } catch (error) {
      throw new Error(`${name}: ${String(error)}`);
    }
    passed.push(name);
  }
  return passed;
}
