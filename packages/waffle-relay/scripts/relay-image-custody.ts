import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  archivedLayer,
  checkLayerDescriptor,
  layerIdentity,
  type QualifiedLayer,
  type LayerSource,
  webLayerSource,
} from "./relay-image-layers.ts";
import {
  array,
  hash,
  imageRepository,
  localImage,
  publicationContext,
  record,
} from "./relay-image-contract.ts";

async function fileHash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
function json(bytes: Uint8Array): unknown {
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}
function member(archive: string, path: string): Buffer {
  assert.match(
    path,
    /^(manifest\.json|[0-9a-f]{64}\.json|blobs\/sha256\/[0-9a-f]{64})$/,
    "Unsafe image archive member",
  );
  return execFileSync("tar", ["-xOf", archive, path], { maxBuffer: 4 * 1024 * 1024 });
}
function runtimeConfig(value: unknown) {
  const config = record(value);
  return {
    User: config.User,
    Entrypoint: config.Entrypoint,
    Cmd: config.Cmd,
    Env: config.Env,
    Labels: config.Labels,
  };
}
export function checkConfig(
  bytes: Uint8Array,
  spec: ReturnType<typeof publicationContext>["specification"],
) {
  const config = record(json(bytes));
  assert.equal(`${config.os}/${config.architecture}`, spec.platform, "Wrong saved platform");
  const runtime = runtimeConfig(config.config);
  assert.equal(runtime.User, "1000:1000");
  assert.deepEqual(runtime.Entrypoint, [
    "/usr/local/bin/node",
    "/app/node_modules/waffle-relay/dist/cli.js",
  ]);
  assert.deepEqual(runtime.Cmd, ["serve", "--config", "/app/relay.json"]);
  const labels = record(runtime.Labels);
  assert.equal(labels["org.opencontainers.image.source"], "https://github.com/ShaulLavo/waffle");
  assert.equal(
    labels["org.opencontainers.image.revision"],
    spec.source,
    "Wrong image release source",
  );
  assert.equal(
    labels["org.opencontainers.image.version"],
    spec.version,
    "Wrong image release version",
  );
  const rootfs = record(config.rootfs);
  assert.equal(rootfs.type, "layers");
  const diffIds = array(rootfs.diff_ids).map((layer) => {
    assert.equal(typeof layer, "string");
    assert.match(String(layer), /^sha256:[0-9a-f]{64}$/);
    return String(layer);
  });
  return { config, runtime, diffIds };
}
async function savedImage(directory: string, context: ReturnType<typeof publicationContext>) {
  const archive = join(directory, "image.tar.gz");
  const manifestBytes = member(archive, "manifest.json");
  const manifests = array(json(manifestBytes));
  assert.equal(manifests.length, 1, "Expected exactly one saved image");
  const manifest = record(manifests[0]);
  assert.deepEqual(manifest.RepoTags, [localImage], "Wrong saved variant image tag");
  assert.equal(typeof manifest.Config, "string");
  const configBytes = member(archive, String(manifest.Config));
  const configDigest = `sha256:${hash(configBytes)}`;
  const checked = checkConfig(configBytes, context.specification);
  const paths = array(manifest.Layers);
  assert.equal(paths.length, checked.diffIds.length, "Saved layer count differs");
  const layers: Awaited<ReturnType<typeof archivedLayer>>[] = [];
  for (const [index, path] of paths.entries()) {
    const layer = await archivedLayer(archive, path);
    assert.equal(layer.diffId, checked.diffIds[index], "Saved layer content differs from config");
    layers.push(layer);
  }
  return {
    archiveManifestSha256: hash(manifestBytes),
    configDigest,
    configBytes,
    layers,
    ...checked,
  };
}
function inspect(reference: string): Record<string, unknown> {
  return record(array(json(execFileSync("docker", ["image", "inspect", reference])))[0]);
}
export function checkInspection(
  value: unknown,
  saved: Pick<Awaited<ReturnType<typeof savedImage>>, "runtime" | "diffIds">,
) {
  const image = record(value);
  assert.equal(`${image.Os}/${image.Architecture}`, "linux/amd64", "Wrong loaded platform");
  assert.deepEqual(runtimeConfig(image.Config), saved.runtime, "Loaded image config differs");
  assert.deepEqual(record(image.RootFS).Layers, saved.diffIds, "Loaded image rootfs differs");
  assert.match(String(image.Id), /^sha256:[0-9a-f]{64}$/, "Expected an engine image identity");
  return String(image.Id);
}
function savedIdentity(
  directory: string,
  saved: Awaited<ReturnType<typeof savedImage>>,
  engineId: string,
) {
  // The engine ID is opaque. If it names a saved manifest, verify that blob separately.
  let manifestDigest: string | null = null;
  if (engineId !== saved.configDigest) {
    const bytes = member(join(directory, "image.tar.gz"), `blobs/sha256/${engineId.slice(7)}`);
    assert.equal(`sha256:${hash(bytes)}`, engineId, "Saved manifest hash differs");
    const manifest = record(json(bytes));
    assert.equal(
      record(manifest.config).digest,
      saved.configDigest,
      "Saved manifest config differs",
    );
    assert.equal(record(manifest.config).size, saved.configBytes.length);
    const descriptors = array(manifest.layers);
    assert.equal(descriptors.length, saved.layers.length, "Saved manifest layer count differs");
    saved.layers.forEach((layer, index) => checkLayerDescriptor(descriptors[index], layer));
    manifestDigest = engineId;
  }
  return {
    engineId,
    archiveManifestSha256: saved.archiveManifestSha256,
    configDigest: saved.configDigest,
    manifestDigest,
    layers: saved.layers.map(({ diffId, uncompressedSize }) => ({ diffId, uncompressedSize })),
  };
}
export async function verifyArtifact(directory: string, env: NodeJS.ProcessEnv) {
  const context = publicationContext(env);
  const receiptBytes = readFileSync(join(directory, "receipt.json"));
  assert.match(env.RECEIPT_SHA256 ?? "", /^[0-9a-f]{64}$/, "Missing producer receipt hash");
  assert.equal(hash(receiptBytes), env.RECEIPT_SHA256, "Producer receipt hash differs");
  const receipt = record(json(receiptBytes));
  assert.deepEqual(receipt.context, context, "Wrong source, variant, platform or run custody");
  assert.equal(
    await fileHash(join(directory, "image.tar.gz")),
    receipt.archiveSha256,
    "Saved archive hash differs",
  );
  const image = record(receipt.image);
  assert.match(String(image.engineId), /^sha256:[0-9a-f]{64}$/);
  const saved = await savedImage(directory, context);
  assert.deepEqual(
    image,
    savedIdentity(directory, saved, String(image.engineId)),
    "Saved image identities differ",
  );
  return { context, receipt, saved };
}
export async function checkPublished(
  manifestBytes: Uint8Array,
  configBytes: Uint8Array,
  reference: string,
  expectedConfig: Uint8Array,
  expectedLayers: readonly QualifiedLayer[],
  readLayer: (digest: string) => Promise<LayerSource>,
) {
  assert.match(
    reference,
    /^ghcr\.io\/shaullavo\/waffle-relay@sha256:[0-9a-f]{64}$/,
    "Wrong publication repository or digest",
  );
  assert.equal(
    `${imageRepository}@sha256:${hash(manifestBytes)}`,
    reference,
    "Registry manifest digest differs",
  );
  const manifest = record(json(manifestBytes));
  assert.equal(manifest.schemaVersion, 2);
  const descriptor = record(manifest.config);
  assert.equal(
    descriptor.digest,
    `sha256:${hash(expectedConfig)}`,
    "Published config differs from qualified config",
  );
  assert.equal(descriptor.size, expectedConfig.length);
  assert.equal(
    `sha256:${hash(configBytes)}`,
    descriptor.digest,
    "Registry config blob hash differs",
  );
  assert.deepEqual(
    Buffer.from(configBytes),
    Buffer.from(expectedConfig),
    "Registry config bytes differ",
  );
  const config = record(json(configBytes));
  const descriptors = array(manifest.layers);
  assert.deepEqual(
    array(record(config.rootfs).diff_ids),
    expectedLayers.map((layer) => layer.diffId),
  );
  assert.equal(descriptors.length, expectedLayers.length, "Published layer count differs");
  for (const [index, value] of descriptors.entries()) {
    const descriptor = record(value);
    assert.match(String(descriptor.digest), /^sha256:[0-9a-f]{64}$/);
    const layer = await layerIdentity(await readLayer(String(descriptor.digest)));
    checkLayerDescriptor(descriptor, layer);
    const expected = expectedLayers[index]!;
    assert.equal(
      layer.diffId,
      expected.diffId,
      "Published layer content/order differs from qualified image",
    );
    assert.equal(
      layer.uncompressedSize,
      expected.uncompressedSize,
      "Published layer size differs from qualified image",
    );
  }
}
async function registryLayer(digest: string) {
  const token = process.env.REGISTRY_PULL_TOKEN;
  assert.ok(token, "Expected anonymous registry pull token");
  const response = await fetch(`https://ghcr.io/v2/shaullavo/waffle-relay/blobs/${digest}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60000),
  });
  assert.ok(response.ok && response.body, "Cannot read anonymous registry layer");
  return webLayerSource(response.body);
}

async function main() {
  const [command, directory, reference] = process.argv.slice(2);
  assert.ok(directory, "Expected image custody directory");
  if (command === "record") {
    const context = publicationContext(process.env);
    const saved = await savedImage(directory, context);
    const engineId = checkInspection(inspect(localImage), saved);
    const receipt = {
      context,
      archiveSha256: await fileHash(join(directory, "image.tar.gz")),
      image: savedIdentity(directory, saved, engineId),
    };
    const text = JSON.stringify(receipt, null, 2) + "\n";
    writeFileSync(join(directory, "receipt.json"), text);
    process.stdout.write(hash(text) + "\n");
    return;
  }
  const { receipt, saved } = await verifyArtifact(directory, process.env);
  if (command === "load") {
    execFileSync("docker", ["load", "--input", join(directory, "image.tar.gz")], {
      stdio: "inherit",
    });
    assert.equal(
      checkInspection(inspect(localImage), saved),
      record(receipt.image).engineId,
      "Loaded engine identity differs",
    );
    return;
  }
  assert.equal(command, "published", "Expected record, load or published custody command");
  assert.ok(reference);
  await checkPublished(
    readFileSync(join(directory, "published-manifest.json")),
    readFileSync(join(directory, "published-config.json")),
    reference,
    saved.configBytes,
    saved.layers,
    registryLayer,
  );
  checkInspection(inspect(reference), saved);
  writeFileSync(join(directory, "reference"), reference + "\n");
}
if (import.meta.main) await main();
