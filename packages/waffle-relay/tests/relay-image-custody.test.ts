import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkConfig,
  checkInspection,
  checkPublished,
  verifyArtifact,
} from "../scripts/relay-image-custody.ts";
import {
  hash,
  localImage,
  publicationContext,
  specification,
  variant,
} from "../scripts/relay-image-contract.ts";

const sourceHead = "1".repeat(40);
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
    rootfs: { type: "layers", diff_ids: [`sha256:${"a".repeat(64)}`] },
  };
}
async function fixture(directory: string, manifestId: boolean) {
  const bytes = Buffer.from(JSON.stringify(config()));
  const configDigest = `sha256:${hash(bytes)}`;
  const manifestBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      config: { digest: configDigest, size: bytes.length },
      layers: [{ digest: `sha256:${"b".repeat(64)}` }],
    }),
  );
  const manifestDigest = `sha256:${hash(manifestBytes)}`;
  const configPath = `blobs/sha256/${hash(bytes)}`;
  const archiveManifest = Buffer.from(
    JSON.stringify([{ Config: configPath, RepoTags: [localImage], Layers: ["layer.tar"] }]),
  );
  const contents = join(directory, "contents");
  await mkdir(join(contents, "blobs/sha256"), { recursive: true });
  await writeFile(join(contents, configPath), bytes);
  await writeFile(join(contents, `blobs/sha256/${hash(manifestBytes)}`), manifestBytes);
  await writeFile(join(contents, "manifest.json"), archiveManifest);
  await writeFile(join(contents, "layer.tar"), "synthetic layer");
  execFileSync("tar", [
    "-czf",
    join(directory, "image.tar.gz"),
    "-C",
    contents,
    "manifest.json",
    "blobs",
    "layer.tar",
  ]);
  const receipt = {
    context: publicationContext(environment()),
    archiveSha256: hash(await readFile(join(directory, "image.tar.gz"))),
    image: {
      engineId: manifestId ? manifestDigest : configDigest,
      configDigest,
      archiveManifestSha256: hash(archiveManifest),
      manifestDigest: manifestId ? manifestDigest : null,
    },
  };
  async function save() {
    const text = JSON.stringify(receipt);
    await writeFile(join(directory, "receipt.json"), text);
    return { ...environment(), RECEIPT_SHA256: hash(text) };
  }
  return { receipt, save, bytes, manifestBytes, manifestDigest, env: await save() };
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

test("registry proof hashes actual manifest and config, not the local image ID", async () => {
  await withFixture(true, async (_directory, input) => {
    const reference = `ghcr.io/shaullavo/waffle-relay@${input.manifestDigest}`;
    expect(input.manifestDigest).not.toBe(input.receipt.image.configDigest);
    expect(() =>
      checkPublished(input.manifestBytes, input.bytes, reference, input.bytes),
    ).not.toThrow();
    expect(() =>
      checkPublished(
        input.manifestBytes,
        input.bytes,
        reference.replace("waffle-relay@", "other@"),
        input.bytes,
      ),
    ).toThrow("repository");
    expect(() => checkPublished(Buffer.from("{}"), input.bytes, reference, input.bytes)).toThrow(
      "manifest digest",
    );
    expect(() =>
      checkPublished(input.manifestBytes, Buffer.from("{}"), reference, input.bytes),
    ).toThrow("blob hash");
    expect(() =>
      checkPublished(input.manifestBytes, input.bytes, reference, Buffer.from("{}")),
    ).toThrow("qualified config");
  });
});
