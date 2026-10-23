import { expect, test } from "bun:test";
import {
  MemoryBackend,
  FilesystemClient,
  FilesystemService,
  createFilesystemConnection,
} from "../fs";
import { MAX_IDENTITY_PART, parseFileIdentity, type FileIdentity } from "../fs/file-identity";
import { publicationObserver, type PublicationLimits } from "../fs/publication-internal";
import {
  decodeEffects,
  encodeEffects,
  type ChangePage,
  type PublicationCut,
  type PublicationEffect,
} from "../fs/publication";
import { pack, unpack } from "../fs/protocol";
import { Wasi } from "../core/wasi";
import { shareFileResource } from "../core/open-file";
import { guestFunction, guestModule } from "./fixtures/publication-wasm";

const bytes = (value: string) => new TextEncoder().encode(value);
const limits: PublicationLimits = {
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
};
async function fixture(options = limits, seed?: string) {
  const backend = new MemoryBackend(undefined, {
    workspace: crypto.randomUUID(),
    era: 0xfedcba9876543210n,
  });
  if (seed) backend.fs.writeFile(`/${seed}`, bytes(seed));
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection(undefined, { limits: options, observe: true });
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  const root: number = await client.asyncCall("preopen", ["/"]);
  const observer = publicationObserver(client);
  const resolve = (name: string) => client.asyncCall("resolve", [root, name]);
  const file = async (name: string) => {
    await client.asyncCall("writeFile", [`/${name}`], bytes(name));
    const handle: number = (await resolve(name)).node;
    client.retain(handle);
    return handle;
  };
  return {
    backend,
    service,
    client,
    root,
    observer,
    resolve,
    file,
    stop() {
      client.dispose();
      service.dispose();
    },
  };
}
function groups(page: ChangePage) {
  if (page.kind !== "changes") throw new Error("unexpected history gap");
  return page.publications;
}
function identity(reference: object, expected: FileIdentity) {
  expect(reference).toMatchObject(expected);
}
function affected(changes: readonly PublicationEffect[], expected: FileIdentity) {
  expect(changes.length).toBeGreaterThan(0);
  for (const effect of changes) {
    if (effect.kind === "entry") continue;
    identity(effect.file, expected);
    expect(expected.id).not.toBe(BigInt(effect.file.ino));
    if (effect.kind === "bytes" || effect.kind === "resize")
      expect(expected.version).not.toBe(BigInt(effect.version));
  }
}
async function latest(current: Awaited<ReturnType<typeof fixture>>, cut: PublicationCut) {
  const publications = groups(await current.observer.changes(cut, limits.logBytes));
  expect(publications).toHaveLength(1);
  expect(publications[0]!.receipt.durability).toEqual({ kind: "untracked" });
  return publications[0]!;
}

test("historical host, service and direct groups preserve actual durable revisions after later writes", async () => {
  const current = await fixture();
  const { backend, client, observer } = current;
  try {
    const handle = await current.file("file");
    let cut = await observer.cut();
    await client.asyncCall("writeFile", ["/file"], bytes("host"));
    const hostIdentity = backend.identity(handle),
      host = await latest(current, cut);
    affected(host.changes, hostIdentity);
    cut = host.receipt.cut;
    await client.asyncCall("setMode", [handle, 0o200]);
    const metadataIdentity = backend.identity(handle),
      metadata = await latest(current, cut);
    affected(metadata.changes, metadataIdentity);
    expect(metadataIdentity.version).not.toBe(hostIdentity.version);
    cut = metadata.receipt.cut;
    expect(client.tryWrite(handle, [bytes("D")], 0)).toBe(1);
    const directIdentity = backend.identity(handle),
      direct = await latest(current, cut);
    affected(direct.changes, directIdentity);
    cut = direct.receipt.cut;
    expect(client.setMtime(handle, 42)).toBe(0);
    const timestampIdentity = backend.identity(handle),
      timestamp = await latest(current, cut);
    affected(timestamp.changes, timestampIdentity);
    await client.asyncCall("writeFile", ["/file"], bytes("later"));
    affected(host.changes, hostIdentity);
    affected(metadata.changes, metadataIdentity);
    affected(direct.changes, directIdentity);
    affected(timestamp.changes, timestampIdentity);
    const recovered = groups(await observer.changes(host.receipt.cut, limits.logBytes));
    expect(recovered.slice(0, 3)).toEqual([metadata, direct, timestamp]);
    const encoded = encodeEffects(host.receipt, host.changes, limits.effectBytes);
    expect(decodeEffects(encoded)).toEqual(host);
    expect(backend.identity(handle).version).not.toBe(hostIdentity.version);
  } finally {
    current.stop();
  }
});

test("namespace edges retain resulting parent, hard-link, replaced and deleted identities", async () => {
  const current = await fixture();
  const { backend, client, observer, root, resolve } = current;
  try {
    let cut = await observer.cut();
    const source = await current.file("source"),
      born = await latest(current, cut);
    const created = born.changes.find((effect) => effect.kind === "inode");
    expect(created?.kind).toBe("inode");
    if (created?.kind !== "inode") throw new Error("missing creation");
    identity(created.file, backend.identity(source));
    const destination = await current.file("destination");
    const originalDestination = backend.identity(destination),
      parentBefore = backend.identity(root);
    cut = await observer.cut();
    await client.asyncCall("link", [await resolve("source"), await resolve("alias")]);
    const linked = await latest(current, cut),
      linkIdentity = backend.identity(source);
    const link = linked.changes.find((effect) => effect.kind === "entry");
    if (link?.kind !== "entry" || !link.after) throw new Error("missing link");
    identity(link.parent, backend.identity(root));
    identity(link.after, linkIdentity);
    expect(link.before).toBeNull();
    expect(backend.identity(root).version).not.toBe(parentBefore.version);
    cut = linked.receipt.cut;
    await client.asyncCall("rename", [await resolve("source"), await resolve("destination")]);
    const renamed = await latest(current, cut),
      sourceRevision = backend.identity(source),
      removedRevision = backend.identity(destination),
      parentRevision = backend.identity(root);
    const edges = renamed.changes.filter((effect) => effect.kind === "entry");
    expect(edges).toHaveLength(2);
    for (const edge of edges) identity(edge.parent, parentRevision);
    const removed = edges.find((edge) => edge.name === "source"),
      replaced = edges.find((edge) => edge.name === "destination");
    if (!removed?.before || !replaced?.before || !replaced.after)
      throw new Error("incomplete rename");
    identity(removed.before, sourceRevision);
    expect(removed.after).toBeNull();
    identity(replaced.before, removedRevision);
    identity(replaced.after, sourceRevision);
    expect(removedRevision.id).toBe(originalDestination.id);
    expect(removedRevision.version).not.toBe(originalDestination.version);
    expect(sourceRevision.id).toBe(linkIdentity.id);
    cut = renamed.receipt.cut;
    await client.asyncCall("remove", ["/destination"]);
    await latest(current, cut);
    cut = await observer.cut();
    await client.asyncCall("remove", ["/alias"]);
    const deleted = await latest(current, cut),
      deletedRevision = backend.identity(source);
    const unlink = deleted.changes.find((effect) => effect.kind === "entry");
    if (unlink?.kind !== "entry" || !unlink.before) throw new Error("missing unlink");
    identity(unlink.before, deletedRevision);
    identity(unlink.parent, backend.identity(root));
    expect(unlink.after).toBeNull();
    expect(client.tryWrite(destination, [bytes("R")], 0)).toBe(1);
    expect(client.tryWrite(source, [bytes("S")], 0)).toBe(1);
    await current.file("destination");
    identity(replaced.before, removedRevision);
    identity(replaced.after, sourceRevision);
    identity(unlink.before, deletedRevision);
    expect(backend.identity(destination).version).not.toBe(removedRevision.version);
    expect(groups(await observer.changes(renamed.receipt.cut, limits.logBytes))[1]).toEqual(
      deleted,
    );
  } finally {
    current.stop();
  }
});

test("actual WASI byte, resize and timestamp publications retain one durable revision per group", async () => {
  const current = await fixture();
  const guestClient = new FilesystemClient(current.client.fork());
  const memory = new WebAssembly.Memory({ initial: 4 });
  const wasi = new Wasi({
    args: [],
    env: {},
    fs: guestClient,
    preopens: {},
    namespaces: { env: { memory } },
    stdout() {},
    stderr() {},
    sleep() {
      throw new Error("unexpected sleep");
    },
  });
  try {
    await current.file("guest");
    const root = await guestClient.asyncCall("preopen", ["/"]);
    const handle: number = (await guestClient.asyncCall("resolve", [root, "guest"])).node;
    guestClient.retain(handle);
    const resource = { kind: "file" as const, handle, offset: 0, append: false };
    shareFileResource(resource, guestClient.connection);
    const fd = wasi.descriptors.open(
      resource,
      (1n << 1n) | (1n << 2n) | (1n << 6n) | (1n << 22n) | (1n << 23n),
      0n,
    );
    const module = guestModule("wasi_snapshot_preview1", [
      { name: "fd_pwrite", parameters: ["i32", "i32", "i32", "i64", "i32"] },
      { name: "fd_filestat_set_size", parameters: ["i32", "i64"] },
      { name: "fd_filestat_set_times", parameters: ["i32", "i64", "i64", "i32"] },
    ]);
    const guest = new WebAssembly.Instance(module, wasi.imports(module));
    wasi.start(guest);
    const view = new DataView(memory.buffer);
    view.setUint32(0, 256, true);
    view.setUint32(4, 1, true);
    new Uint8Array(memory.buffer)[256] = 90;
    let cut = await current.observer.cut();
    const available = current.backend.shared.identities.available;
    expect(guestFunction(guest, "fd_pwrite")(fd, 0, 1, 1n, 32)).toBe(0);
    const written = await latest(current, cut),
      writeIdentity = current.backend.identity(handle);
    affected(written.changes, writeIdentity);
    expect(available - current.backend.shared.identities.available).toBe(1n);
    cut = written.receipt.cut;
    expect(guestFunction(guest, "fd_filestat_set_size")(fd, 7n)).toBe(0);
    const resized = await latest(current, cut),
      sizeIdentity = current.backend.identity(handle);
    affected(resized.changes, sizeIdentity);
    cut = resized.receipt.cut;
    expect(guestFunction(guest, "fd_filestat_set_times")(fd, 0n, 42000000n, 4)).toBe(0);
    const timed = await latest(current, cut);
    affected(timed.changes, current.backend.identity(handle));
    affected(written.changes, writeIdentity);
    affected(resized.changes, sizeIdentity);
  } finally {
    wasi.descriptors.dispose();
    guestClient.dispose();
    current.stop();
  }
});

test("failed effect capacity and identity exhaustion preserve allocation, tree, versions and cut", async () => {
  const current = await fixture();
  const { backend, client, observer } = current;
  try {
    const file = await current.file("stable");
    const before = backend.identity(file),
      cut = await observer.cut();
    const available = backend.shared.identities.available;
    rejectPlanCapacity(backend);
    expect(backend.shared.identities.available).toBe(available);
    expect(backend.fs.lookup("/uncommitted")).toBeUndefined();
    expect(backend.identity(file)).toEqual(before);
    expect(await observer.cut()).toEqual(cut);
    backend.shared.identities.configure(
      { workspace: backend.workspaceId, era: 0xfedcba9876543210n },
      MAX_IDENTITY_PART - 1n,
    );
    let failure: unknown;
    try {
      await client.asyncCall("mkdirp", ["/exhausted/child"]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ errno: 33 });
    expect(backend.shared.identities.available).toBe(1n);
    expect(backend.fs.lookup("/exhausted")).toBeUndefined();
    expect(backend.identity(file)).toEqual(before);
    expect(await observer.cut()).toEqual(cut);
    const original = client.shared.snapshot(file)!.data;
    const noEffect = backend.shared.identities.available;
    await client.asyncCall("setMtime", [file, backend.shared.stat(file)!.mtime]);
    expect(client.tryWrite(file, [new Uint8Array()], 0)).toBe(0);
    expect(backend.shared.identities.available).toBe(noEffect);
    expect(await observer.cut()).toEqual(cut);
    expect(client.shared.snapshot(file)!.data).toEqual(original);
    backend.shared.identities.configure(
      { workspace: backend.workspaceId, era: 0xfedcba9876543210n },
      MAX_IDENTITY_PART,
    );
    expect(client.tryWrite(file, [bytes("bad")], 0)).toBe(-33);
    expect(client.setMtime(file, 43)).toBe(33);
    await rejectsErrno(client.asyncCall("setMode", [file, 0o400]), 33);
    expect(backend.shared.identities.available).toBe(0n);
    expect(backend.identity(file)).toEqual(before);
    expect(client.shared.snapshot(file)!.data).toEqual(original);
    expect(await observer.cut()).toEqual(cut);
    expect(await observer.changes({ history: "other", generation: 0 }, limits.logBytes)).toEqual({
      kind: "gap",
      current: cut,
    });
  } finally {
    current.stop();
  }
});

function rejectPlanCapacity(backend: MemoryBackend) {
  const domain = backend.shared.publication!;
  backend.shared.mutate(undefined, undefined, () => {
    const intent = { kind: "mkdirp" as const, path: "/uncommitted/nested" };
    const plan = backend.planPublication(intent, new Uint8Array());
    const session = domain.openSession();
    const admitted = domain.admit(session, domain.next(session), intent, new Uint8Array());
    if (admitted.kind !== "admitted") throw new Error("missing admission");
    try {
      expect(() =>
        domain.prepare(
          admitted.admission,
          plan.result,
          plan.changes.concat(Array.from({ length: limits.effects }, () => plan.changes[0]!)),
        ),
      ).toThrow();
    } finally {
      backend.discardPublication(plan);
      domain.cancel(session, admitted.admission);
      domain.closeSession(session);
    }
  });
}

test("service and shared byte admission reject before durable allocation or visible effects", async () => {
  const current = await fixture({ ...limits, effectBytes: 300 }, "stable");
  try {
    const handle: number = (await current.resolve("stable")).node;
    current.client.retain(handle);
    const before = current.backend.identity(handle);
    const stat = current.backend.shared.stat(handle);
    const allocation = current.backend.shared.identities.available;
    const cut = await current.observer.cut();
    const original = current.client.shared.snapshot(handle)!.data.slice();
    await rejectsErrno(current.client.asyncCall("writeFile", ["/stable"], bytes("bad")), 6);
    await rejectsErrno(current.client.asyncCall("setMode", [handle, 0o400]), 6);
    await rejectsErrno(current.client.asyncCall("mkdirp", ["/bad/child"]), 6);
    expect(current.client.tryWrite(handle, [bytes("bad")], 0)).toBe(-6);
    expect(current.client.setMtime(handle, 42)).toBe(6);
    expect(current.backend.shared.identities.available).toBe(allocation);
    expect(current.backend.identity(handle)).toEqual(before);
    expect(current.backend.fs.lookup("/bad")).toBeUndefined();
    expect(current.client.shared.snapshot(handle)!.data).toEqual(original);
    expect(current.backend.shared.stat(handle)).toEqual(stat);
    expect(await current.observer.cut()).toEqual(cut);
    expect(groups(await current.observer.changes(cut, limits.logBytes))).toEqual([]);
  } finally {
    current.stop();
  }
});

async function rejectsErrno(action: Promise<unknown>, errno: number) {
  let failure: unknown;
  try {
    await action;
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ errno });
}

test("publication identity and service codecs preserve full-width revisions and reject malformed values", () => {
  const file = {
    birthHistory: "codec-history",
    ino: 42,
    ...parseFileIdentity({
      id: "fffffffffffffffffffffffffffffffe",
      version: "ffffffffffffffffffffffffffffffff",
    }),
  };
  const receipt = {
    id: { session: 1, sequence: 1 },
    cut: { history: file.birthHistory, generation: 1 },
    result: { kind: "void" as const },
    durability: { kind: "untracked" as const },
  };
  const changes: PublicationEffect[] = [
    { kind: "bytes", file, offset: 0, bytes: new Uint8Array([0, 128, 255]), size: 3, version: 1 },
    { kind: "entry", parent: file, name: "deleted", before: file, after: null },
  ];
  const publication = { receipt, changes };
  expect(decodeEffects(encodeEffects(receipt, changes, limits.effectBytes))).toEqual(publication);
  expect(unpack(pack(publication))).toEqual(publication);
  const malformed = encodeEffects(receipt, changes, limits.effectBytes);
  const headerLength = new DataView(malformed.buffer).getUint32(0, true);
  const header = new TextDecoder().decode(malformed.subarray(4, 4 + headerLength));
  const invalidHeader = header.replace(
    '"id":"fffffffffffffffffffffffffffffffe"',
    '"id":"0ffffffffffffffffffffffffffffffe"',
  );
  expect(invalidHeader).not.toBe(header);
  malformed.set(bytes(invalidHeader), 4);
  expect(() => decodeEffects(malformed)).toThrow();
  for (const value of [
    "0",
    "01",
    "ABC",
    "10000000000000000",
    "100000000000000000000000000000000",
  ]) {
    expect(() => parseFileIdentity({ id: value, version: value })).toThrow();
  }
  expect(() =>
    parseFileIdentity({ id: file.version.toString(16), version: file.id.toString(16) }),
  ).toThrow();
  expect(() => unpack(bytes('{"$bigint":"01"}'))).toThrow();
  expect(() => unpack(bytes('{"$bytes":[256]}'))).toThrow();
});
