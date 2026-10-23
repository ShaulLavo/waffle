import assert from "node:assert/strict";
import { DescriptorTable, type Descriptor } from "../../core/descriptors.ts";
import { FilesystemClient } from "../../fs/client.ts";
import { MemoryBackend } from "../../fs/backend.ts";
import { FilesystemService } from "../../fs/service.ts";
import {
  connectFilesystemIdentity,
  createFilesystemConnection,
  createProcessFilesystemIdentity,
  releaseFilesystemReservation,
} from "../../fs/protocol.ts";
import {
  createFilesystemDescriptorCodec,
  isFilesystemDescriptorToken,
  type FilesystemDescriptorToken,
} from "../../proc/filesystem-codec.ts";

export const Int32Array = globalThis.Int32Array;

/** @compileFixture Parsed by the authority guard, never called. */
export function unlistedGetter(view: Int32Array): ArrayBufferLike {
  return view.buffer;
}

function repeatedExports(
  codec: ReturnType<typeof createFilesystemDescriptorCodec>,
  descriptor: Descriptor,
  expected: SharedArrayBuffer,
  tokens: FilesystemDescriptorToken[],
): void {
  const prototype = Object.getPrototypeOf(Int32Array.prototype);
  const original = Object.getOwnPropertyDescriptor(prototype, "buffer");
  assert.ok(original);
  const replacement = new SharedArrayBuffer(16);
  let calls = 0;
  Object.defineProperty(prototype, "buffer", {
    configurable: true,
    get() {
      calls++;
      return replacement;
    },
  });
  try {
    assert.equal(new Int32Array(4).buffer, replacement, "replacement getter control");
    assert.equal(calls, 1, "ordinary lookup invokes replacement getter");
    calls = 0;
    for (let index = 0; index < 2; index++) {
      const token = codec.export(descriptor, index);
      assert.ok(isFilesystemDescriptorToken(token));
      tokens.push(token);
      assert.equal(token.offset, expected, "repeated export preserves offset buffer identity");
      assert.equal(calls, 0, "repeated export avoids mutable buffer getter");
    }
  } finally {
    Object.defineProperty(prototype, "buffer", original);
  }
}

async function repeatedFilesystemExports(imported: boolean): Promise<void> {
  const service = new FilesystemService(new MemoryBackend());
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  const parent = new DescriptorTable();
  const childTable = new DescriptorTable();
  const tokens: FilesystemDescriptorToken[] = [];
  let child: FilesystemClient | undefined;
  try {
    await client.asyncCall("writeFile", ["/file"], new TextEncoder().encode("abcdef"));
    const root = await client.asyncCall("preopen", ["/"]);
    const { node: handle } = await client.asyncCall("resolve", [root, "file"]);
    client.retain(handle);
    const fd = parent.open({ kind: "file", handle, offset: 3, append: true }, 7n, 0n, () =>
      client.release(handle),
    );
    const identity = createProcessFilesystemIdentity(client.connection);
    const exporter = createFilesystemDescriptorCodec(client, identity);
    const descriptor = parent.get(fd);
    assert.ok(descriptor);
    const token = exporter.export(descriptor, fd);
    assert.ok(isFilesystemDescriptorToken(token));
    tokens.push(token);
    assert.ok(token.offset);
    if (!imported) return repeatedExports(exporter, descriptor, token.offset, tokens);
    const received = structuredClone(token);
    assert.ok(received.offset);
    const childConnection = connectFilesystemIdentity(identity);
    service.connect(childConnection.server);
    child = new FilesystemClient(childConnection.client);
    const description = createFilesystemDescriptorCodec(child).import(received, fd);
    const childFd = childTable.add(description, { rightsBase: 7n, rightsInheriting: 0n });
    const childDescriptor = childTable.get(childFd);
    assert.ok(childDescriptor);
    assert.equal(description.resource.kind, "file");
    const next = createProcessFilesystemIdentity(child.connection);
    repeatedExports(
      createFilesystemDescriptorCodec(child, next),
      childDescriptor,
      received.offset,
      tokens,
    );
    assert.equal(descriptor.resource.kind === "file" && descriptor.resource.offset, 3);
    assert.equal(descriptor.resource.kind === "file" && descriptor.resource.append, true);
  } finally {
    for (const token of tokens) releaseFilesystemReservation(token.reservation);
    childTable.dispose();
    parent.dispose();
    child?.dispose();
    client.dispose();
    service.dispose();
  }
}

if (import.meta.main) await repeatedFilesystemExports(process.argv[2] === "imported");
