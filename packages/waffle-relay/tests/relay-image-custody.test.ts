import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { checkLayerDescriptor, layerIdentity } from "../scripts/relay-image-layers.ts";
import {
  checkConfig,
  checkInspection,
  checkPublished,
  verifyArtifact,
} from "../scripts/relay-image-custody.ts";
import {
  hash,
  array,
  record,
  localImage,
  publicationContext,
  specification,
  variant,
} from "../scripts/relay-image-contract.ts";

const sourceHead = "1".repeat(40);
const layerBytes = [Buffer.from("first qualified layer"), Buffer.from("second qualified layer")];
const expectedLayers = layerBytes.map((bytes) => ({
  diffId: `sha256:${hash(bytes)}`,
  uncompressedSize: bytes.length,
}));
async function fixtureLayer(digest: string) {
  return [
    layerBytes.find((bytes) => `sha256:${hash(bytes)}` === digest) ?? Buffer.from("wrong blob"),
  ];
}
function environment(selected = "native") {
  return {
    IMAGE_VARIANT: selected,
    GITHUB_SHA: sourceHead,
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
  };
}
function config(selected = "native") {
  const spec = specification(selected);
  return {
    os: "linux",
    architecture: "amd64",
    config: {
      User: "1000:1000",
      Entrypoint: ["/usr/local/bin/node", "/app/node_modules/waffle-relay/dist/cli.js"],
      Cmd: ["serve", "--config", "/app/relay.json"],
      Env: ["NODE_ENV=production"],
      Labels: {
        "org.opencontainers.image.source": "https://github.com/ShaulLavo/waffle",
        "org.opencontainers.image.revision": spec.source,
        "org.opencontainers.image.version": spec.version,
      },
    },
    rootfs: { type: "layers", diff_ids: expectedLayers.map((layer) => layer.diffId) },
  };
}
async function fixture(directory: string, manifestId: boolean) {
  const bytes = Buffer.from(JSON.stringify(config()));
  const configDigest = `sha256:${hash(bytes)}`;
  const manifestBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      config: { digest: configDigest, size: bytes.length },
      layers: layerBytes.map((bytes) => ({
        mediaType: "application/vnd.oci.image.layer.v1.tar",
        digest: `sha256:${hash(bytes)}`,
        size: bytes.length,
      })),
    }),
  );
  const manifestDigest = `sha256:${hash(manifestBytes)}`;
  const configPath = `blobs/sha256/${hash(bytes)}`;
  const archiveManifest = Buffer.from(
    JSON.stringify([
      {
        Config: configPath,
        RepoTags: [localImage],
        Layers: layerBytes.map((bytes) => `blobs/sha256/${hash(bytes)}`),
      },
    ]),
  );
  const contents = join(directory, "contents");
  await mkdir(join(contents, "blobs/sha256"), { recursive: true });
  await writeFile(join(contents, configPath), bytes);
  await writeFile(join(contents, `blobs/sha256/${hash(manifestBytes)}`), manifestBytes);
  await writeFile(join(contents, "manifest.json"), archiveManifest);
  for (const layer of layerBytes)
    await writeFile(join(contents, `blobs/sha256/${hash(layer)}`), layer);
  execFileSync("tar", [
    "-czf",
    join(directory, "image.tar.gz"),
    "-C",
    contents,
    "manifest.json",
    "blobs",
  ]);
  const receipt = {
    context: publicationContext(environment()),
    archiveSha256: hash(await readFile(join(directory, "image.tar.gz"))),
    image: {
      engineId: manifestId ? manifestDigest : configDigest,
      configDigest,
      archiveManifestSha256: hash(archiveManifest),
      manifestDigest: manifestId ? manifestDigest : null,
      layers: expectedLayers,
    },
  };
  async function save() {
    const text = JSON.stringify(receipt);
    await writeFile(join(directory, "receipt.json"), text);
    return { ...environment(), RECEIPT_SHA256: hash(text) };
  }
  async function repack() {
    execFileSync("tar", [
      "-czf",
      join(directory, "image.tar.gz"),
      "-C",
      contents,
      "manifest.json",
      "blobs",
    ]);
    receipt.archiveSha256 = hash(await readFile(join(directory, "image.tar.gz")));
    return save();
  }
  return {
    receipt,
    save,
    repack,
    contents,
    bytes,
    manifestBytes,
    manifestDigest,
    env: await save(),
  };
}
async function withFixture(
  manifestId: boolean,
  run: (directory: string, input: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "relay-custody-"));
  try {
    await run(directory, await fixture(directory, manifestId));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const manifestId of [false, true]) {
  test(`actual config identity is independent of the engine's ${manifestId ? "manifest" : "config"} ID`, async () => {
    await withFixture(manifestId, async (directory, input) => {
      const checked = await verifyArtifact(directory, input.env);
      expect(checked.saved.configDigest).toBe(`sha256:${hash(input.bytes)}`);
      expect(checked.receipt.image).toEqual(input.receipt.image);
      const saved = config();
      expect(() =>
        checkInspection(
          {
            Id: input.receipt.image.engineId,
            Os: saved.os,
            Architecture: saved.architecture,
            Config: saved.config,
            RootFS: { Layers: saved.rootfs.diff_ids },
          },
          checked.saved,
        ),
      ).not.toThrow();
    });
  });
}

test("fixed selection preserves WS and rejects an invented variant", () => {
  expect(specification("ws").version).toBe("0.0.109");
  expect(specification("native").version).toBe("0.0.110");
  expect(() => variant("latest")).toThrow("fixed");
  expect(() => variant("")).toThrow("fixed");
});

test("wrong source, variant, run and attempt fail before an image can load", async () => {
  await withFixture(true, async (directory, input) => {
    for (const changed of [
      { IMAGE_VARIANT: "ws" },
      { GITHUB_SHA: "2".repeat(40) },
      { GITHUB_RUN_ID: "124" },
      { GITHUB_RUN_ATTEMPT: "3" },
    ])
      await expect(verifyArtifact(directory, { ...input.env, ...changed })).rejects.toThrow(
        "custody",
      );
    await expect(
      verifyArtifact(directory, { ...input.env, RECEIPT_SHA256: "0".repeat(64) }),
    ).rejects.toThrow("receipt hash");
  });
});

test("archive, saved manifest and config substitutions fail closed", async () => {
  await withFixture(true, async (directory, input) => {
    for (const key of ["configDigest", "archiveManifestSha256"] as const) {
      const original = input.receipt.image[key];
      input.receipt.image[key] = "0".repeat(64);
      await expect(verifyArtifact(directory, await input.save())).rejects.toThrow("identities");
      input.receipt.image[key] = original;
    }
    input.receipt.image.manifestDigest = "0".repeat(64);
    await expect(verifyArtifact(directory, await input.save())).rejects.toThrow("identities");
    await writeFile(join(directory, "image.tar.gz"), "not the qualified archive");
    await expect(verifyArtifact(directory, await input.save())).rejects.toThrow("archive hash");
  });
});

test("saved image config rejects another release, variant and platform", () => {
  const selected = config();
  expect(() => checkConfig(Buffer.from(JSON.stringify(selected)), specification("ws"))).toThrow(
    "source",
  );
  expect(() =>
    checkConfig(
      Buffer.from(JSON.stringify({ ...selected, architecture: "arm64" })),
      specification("native"),
    ),
  ).toThrow("platform");
  const wrong = {
    ...selected,
    config: {
      ...selected.config,
      Labels: { ...selected.config.Labels, "org.opencontainers.image.revision": "0".repeat(40) },
    },
  };
  expect(() => checkConfig(Buffer.from(JSON.stringify(wrong)), specification("native"))).toThrow(
    "source",
  );
});

test("registry proof hashes actual manifest, config and layer blobs", async () => {
  await withFixture(true, async (_directory, input) => {
    const reference = `ghcr.io/shaullavo/waffle-relay@${input.manifestDigest}`;
    expect(input.manifestDigest).not.toBe(input.receipt.image.configDigest);
    const check = (
      manifest = input.manifestBytes,
      configBytes = input.bytes,
      target = reference,
      expected = input.bytes,
    ) => checkPublished(manifest, configBytes, target, expected, expectedLayers, fixtureLayer);
    await expect(check()).resolves.toBeUndefined();
    await expect(
      check(input.manifestBytes, input.bytes, reference.replace("waffle-relay@", "other@")),
    ).rejects.toThrow("repository");
    await expect(check(Buffer.from("{}"))).rejects.toThrow("manifest digest");
    await expect(check(input.manifestBytes, Buffer.from("{}"))).rejects.toThrow("blob hash");
    await expect(
      check(input.manifestBytes, input.bytes, reference, Buffer.from("{}")),
    ).rejects.toThrow("qualified config");
  });
});

for (const kind of ["digest", "size", "missing", "reordered"] as const) {
  test(`publication rejects ${kind} layer identity`, async () => {
    await withFixture(true, async (_directory, input) => {
      const manifest = record(JSON.parse(input.manifestBytes.toString()));
      const layers = array(manifest.layers).map(record);
      if (kind === "digest") layers[0]!.digest = `sha256:${"f".repeat(64)}`;
      if (kind === "size") layers[0]!.size = Number(layers[0]!.size) + 1;
      if (kind === "missing") layers.pop();
      if (kind === "reordered") layers.reverse();
      const changed = Buffer.from(JSON.stringify({ ...manifest, layers }));
      const reference = `ghcr.io/shaullavo/waffle-relay@sha256:${hash(changed)}`;
      await expect(
        Promise.resolve().then(() =>
          checkPublished(
            changed,
            input.bytes,
            reference,
            input.bytes,
            expectedLayers,
            fixtureLayer,
          ),
        ),
      ).rejects.toThrow();
    });
  });
}

for (const manifestId of [false, true]) {
  test(`saved ${manifestId ? "manifest" : "config"} image rejects a changed layer even with refreshed outer hashes`, async () => {
    await withFixture(manifestId, async (directory, input) => {
      await writeFile(
        join(input.contents, `blobs/sha256/${hash(layerBytes[0]!)}`),
        "substituted layer",
      );
      await expect(verifyArtifact(directory, await input.repack())).rejects.toThrow();
    });
  });
}

test("plain and gzip layer streams bind encoded bytes and uncompressed diff IDs", async () => {
  const original = layerBytes[0]!;
  for (const encoded of [original, gzipSync(original)]) {
    const actual = await layerIdentity(Array.from(encoded, (byte) => Uint8Array.of(byte)));
    expect(actual.digest).toBe(`sha256:${hash(encoded)}`);
    expect(actual.size).toBe(encoded.length);
    expect(actual.diffId).toBe(`sha256:${hash(original)}`);
    expect(actual.uncompressedSize).toBe(original.length);
    const descriptor = {
      digest: actual.digest,
      size: actual.size,
      mediaType: actual.gzip
        ? "application/vnd.oci.image.layer.v1.tar+gzip"
        : "application/vnd.oci.image.layer.v1.tar",
    };
    expect(() => checkLayerDescriptor(descriptor, actual)).not.toThrow();
    expect(() =>
      checkLayerDescriptor({ ...descriptor, mediaType: "application/unknown" }, actual),
    ).toThrow("media type");
  }
  await expect(layerIdentity([])).rejects.toThrow();
  await expect(layerIdentity([Buffer.from([0x1f, 0x8b])])).rejects.toThrow();
});

test("saved OCI manifest descriptor sizes bind the actual archived blobs", async () => {
  await withFixture(true, async (directory, input) => {
    const manifest = record(JSON.parse(input.manifestBytes.toString()));
    const layers = array(manifest.layers).map(record);
    layers[0]!.size = Number(layers[0]!.size) + 1;
    const changed = Buffer.from(JSON.stringify({ ...manifest, layers }));
    const digest = `sha256:${hash(changed)}`;
    await writeFile(join(input.contents, `blobs/sha256/${hash(changed)}`), changed);
    input.receipt.image.engineId = digest;
    input.receipt.image.manifestDigest = digest;
    await expect(verifyArtifact(directory, await input.repack())).rejects.toThrow(
      "descriptor size",
    );
  });
});

for (const altered of [false, true]) {
  test(`published gzip layers ${altered ? "reject changed contents" : "preserve qualified contents across compression"}`, async () => {
    const encoded = layerBytes.map((bytes, index) =>
      gzipSync(altered && index === 0 ? Buffer.from("different content") : bytes),
    );
    const bytes = Buffer.from(JSON.stringify(config()));
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        config: { digest: `sha256:${hash(bytes)}`, size: bytes.length },
        layers: encoded.map((layer) => ({
          digest: `sha256:${hash(layer)}`,
          size: layer.length,
          mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        })),
      }),
    );
    const reference = `ghcr.io/shaullavo/waffle-relay@sha256:${hash(manifest)}`;
    const read = async (digest: string) => [
      encoded.find((layer) => `sha256:${hash(layer)}` === digest)!,
    ];
    const result = checkPublished(manifest, bytes, reference, bytes, expectedLayers, read);
    if (altered) await expect(result).rejects.toThrow("content/order");
    else await expect(result).resolves.toBeUndefined();
  });
}

test("published checks accept the actual saved-layer records without losing content checks", async () => {
  await withFixture(true, async (directory, input) => {
    const checked = await verifyArtifact(directory, input.env);
    const reference = `ghcr.io/shaullavo/waffle-relay@${input.manifestDigest}`;
    await expect(
      checkPublished(
        input.manifestBytes,
        input.bytes,
        reference,
        input.bytes,
        checked.saved.layers,
        fixtureLayer,
      ),
    ).resolves.toBeUndefined();
  });
});
