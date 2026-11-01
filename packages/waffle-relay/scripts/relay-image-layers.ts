import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { record } from "./relay-image-contract.ts";

export interface QualifiedLayer {
  readonly diffId: string;
  readonly uncompressedSize: number;
}
async function compressed(source: Readable): Promise<boolean> {
  for (;;) {
    const prefix: unknown = source.read(2);
    if (prefix !== null) {
      assert.ok(Buffer.isBuffer(prefix) && prefix.length === 2, "Truncated layer blob");
      source.unshift(prefix);
      return prefix[0] === 0x1f && prefix[1] === 0x8b;
    }
    assert.ok(!source.readableEnded, "Empty layer blob");
    await once(source, "readable");
  }
}
export async function layerIdentity(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
  const source = Readable.from(chunks, { objectMode: false });
  const encoded = createHash("sha256");
  const decoded = createHash("sha256");
  let size = 0;
  let uncompressedSize = 0;
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      encoded.update(chunk);
      done(null, chunk);
    },
  });
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      uncompressedSize += chunk.length;
      decoded.update(chunk);
      done();
    },
  });
  try {
    const gzip = await compressed(source);
    if (gzip) await pipeline(source, measure, createGunzip(), sink);
    else await pipeline(source, measure, sink);
    return {
      digest: `sha256:${encoded.digest("hex")}`,
      size,
      diffId: `sha256:${decoded.digest("hex")}`,
      uncompressedSize,
      gzip,
    };
  } finally {
    source.destroy();
  }
}
export async function archivedLayer(archive: string, path: unknown) {
  assert.equal(typeof path, "string", "Expected saved layer path");
  assert.match(String(path), /^(blobs\/sha256\/[0-9a-f]{64}|[0-9a-f]{64}\/layer\.tar)$/);
  const child = spawn("tar", ["-xOf", archive, String(path)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = once(child, "exit");
  void exit.catch(() => {});
  child.stderr.resume();
  try {
    const identity = await layerIdentity(child.stdout);
    const [code] = await exit;
    assert.equal(code, 0, "Cannot read saved layer");
    if (String(path).startsWith("blobs/sha256/"))
      assert.equal(
        identity.digest,
        `sha256:${String(path).slice(13)}`,
        "Saved layer blob hash differs",
      );
    return identity;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit.catch(() => {});
  }
}
export function checkLayerDescriptor(
  value: unknown,
  actual: Awaited<ReturnType<typeof layerIdentity>>,
) {
  const descriptor = record(value);
  assert.equal(descriptor.digest, actual.digest, "Layer descriptor digest differs from blob");
  assert.equal(descriptor.size, actual.size, "Layer descriptor size differs from blob");
  const accepted = actual.gzip
    ? [
        "application/vnd.oci.image.layer.v1.tar+gzip",
        "application/vnd.docker.image.rootfs.diff.tar.gzip",
      ]
    : ["application/vnd.oci.image.layer.v1.tar", "application/vnd.docker.image.rootfs.diff.tar"];
  assert.ok(
    accepted.includes(String(descriptor.mediaType)),
    "Layer compression/media type differs",
  );
}
