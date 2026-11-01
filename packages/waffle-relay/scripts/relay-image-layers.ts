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
export type LayerSource = Readable | Iterable<Uint8Array>;
function streamError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Layer source read failed", { cause: value });
}
class WebLayerSource extends Readable {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    super({ objectMode: false });
    this.reader = reader;
  }
  override _read(): void {
    void this.reader.read().then(
      (result) => this.deliver(result),
      (error: unknown) => this.destroy(streamError(error)),
    );
  }
  private deliver(
    result: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>,
  ): void {
    if (this.destroyed) return;
    this.push(result.done ? null : result.value);
  }
  private finish(error: Error | null, done: (error?: Error | null) => void): void {
    this.reader.releaseLock();
    done(error);
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    void this.reader.cancel(error).then(
      () => this.finish(error, done),
      (failure: unknown) => this.finish(error ?? streamError(failure), done),
    );
  }
}
export function webLayerSource(body: ReadableStream<Uint8Array>): Readable {
  return new WebLayerSource(body.getReader());
}
function compressionPrefix(source: Readable): boolean | undefined {
  if (source.errored) throw source.errored;
  const prefix: unknown = source.read(2);
  if (prefix === null) {
    assert.ok(!source.readableEnded && !source.destroyed, "Empty layer blob");
    return;
  }
  assert.ok(Buffer.isBuffer(prefix) && prefix.length === 2, "Truncated layer blob");
  source.unshift(prefix);
  return prefix[0] === 0x1f && prefix[1] === 0x8b;
}
async function compressionStep(source: Readable) {
  const controller = new AbortController();
  const changed = Promise.race(
    ["readable", "end", "close"].map((event) => once(source, event, { signal: controller.signal })),
  );
  void changed.catch(() => {});
  try {
    const result = compressionPrefix(source);
    if (result !== undefined) return result;
    await changed;
  } finally {
    controller.abort();
  }
}
async function compressed(source: Readable): Promise<boolean> {
  for (;;) {
    const result = await compressionStep(source);
    if (result !== undefined) return result;
  }
}
export async function layerIdentity(chunks: LayerSource) {
  const source = chunks instanceof Readable ? chunks : Readable.from(chunks, { objectMode: false });
  const holdError = () => {};
  source.on("error", holdError);
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
    source.removeListener("error", holdError);
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
