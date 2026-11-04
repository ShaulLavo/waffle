import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { archivedLayer, layerIdentity, webLayerSource } from "../../scripts/relay-image-layers.ts";
import { verifyArtifact } from "../../scripts/relay-image-custody.ts";
import {
  hash,
  localImage,
  publicationContext,
  specification,
} from "../../scripts/relay-image-contract.ts";

const scratch = mkdtempSync(join(tmpdir(), "relay-eof-"));
const oldPath = process.env.PATH;
const errors: unknown[] = [];
let childPid: number | undefined;
async function mustReject(promise: Promise<unknown>, label: string) {
  const timeout = Symbol("unsettled");
  const resolved = Symbol("resolved");
  let alarm: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<symbol>((resolve) => {
    alarm = setTimeout(() => resolve(timeout), 1500);
  });
  try {
    const result = await Promise.race([
      promise.then(
        () => resolved,
        (error: unknown) => ({ error }),
      ),
      deadline,
    ]);
    assert.ok(typeof result !== "symbol", `${label} did not reject promptly`);
    console.log(`PASS ${label}`);
  } finally {
    clearTimeout(alarm);
  }
}
async function control(run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    errors.push(error);
    console.error(String(error));
  }
}
function missingMemberReceipt() {
  const env = {
    IMAGE_VARIANT: "native",
    GITHUB_SHA: "1".repeat(40),
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
  };
  const spec = specification("native");
  const diffId = `sha256:${"a".repeat(64)}`;
  const config = Buffer.from(
    JSON.stringify({
      os: "linux",
      architecture: "amd64",
      config: {
        User: "1000:1000",
        Entrypoint: ["/usr/local/bin/node", "/app/node_modules/waffle-relay/dist/cli.js"],
        Cmd: ["serve", "--config", "/app/relay.json"],
        Env: [],
        Labels: {
          "org.opencontainers.image.source": "https://github.com/ShaulLavo/waffle",
          "org.opencontainers.image.revision": spec.source,
          "org.opencontainers.image.version": spec.version,
        },
      },
      rootfs: { type: "layers", diff_ids: [diffId] },
    }),
  );
  const configPath = `${hash(config)}.json`;
  const manifest = Buffer.from(
    JSON.stringify([
      { Config: configPath, RepoTags: [localImage], Layers: [`${"b".repeat(64)}/layer.tar`] },
    ]),
  );
  writeFileSync(join(scratch, configPath), config);
  writeFileSync(join(scratch, "manifest.json"), manifest);
  const archive = join(scratch, "image.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", scratch, "manifest.json", configPath]);
  const receipt = JSON.stringify({
    context: publicationContext(env),
    archiveSha256: hash(readFileSync(archive)),
    image: {
      engineId: `sha256:${hash(config)}`,
      configDigest: `sha256:${hash(config)}`,
      archiveManifestSha256: hash(manifest),
      manifestDigest: null,
      layers: [{ diffId, uncompressedSize: 1024 }],
    },
  });
  writeFileSync(join(scratch, "receipt.json"), receipt);
  return { ...env, RECEIPT_SHA256: hash(receipt) };
}
try {
  await control(async () => {
    const empty = new Readable({
      read() {
        setImmediate(() => this.push(null));
      },
    });
    await mustReject(layerIdentity(empty), "asynchronously empty Node stream");
    assert.ok(empty.destroyed);
  });
  await control(async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from([31, 139, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]));
      },
      cancel() {
        cancelled = true;
      },
    });
    await mustReject(
      layerIdentity(webLayerSource(body)),
      "decoder failure cancels a pending Web body",
    );
    assert.ok(cancelled);
  });
  await control(async () => {
    await mustReject(
      archivedLayer(join(scratch, "missing.tar.gz"), `blobs/sha256/${"a".repeat(64)}`),
      "real tar missing archive",
    );
  });
  await control(async () => {
    await mustReject(
      verifyArtifact(scratch, missingMemberReceipt()),
      "valid outer hashes with missing saved member",
    );
  });
  await control(async () => {
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    const pidFile = join(scratch, "tar.pid");
    writeFileSync(
      join(bin, "tar"),
      `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write(Buffer.from([31,139,1,2,3,4,5,6,7,8,9,10,11,12,13,14]));setInterval(()=>{},1000);\n`,
      { mode: 0o755 },
    );
    process.env.PATH = bin;
    try {
      await mustReject(
        archivedLayer("unused", `${"b".repeat(64)}/layer.tar`),
        "decoder failure stops and joins live tar",
      );
    } finally {
      process.env.PATH = oldPath;
      if (existsSync(pidFile)) childPid = Number(readFileSync(pidFile, "utf8"));
    }
    assert.ok(childPid);
    assert.throws(() => process.kill(childPid!, 0), { code: "ESRCH" });
    childPid = undefined;
  });
} finally {
  process.env.PATH = oldPath;
  if (childPid !== undefined) process.kill(childPid, "SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
}
assert.equal(errors.length, 0, errors.map(String).join("\n"));
console.log("PASS Node failure settlement and owned-child cleanup");
