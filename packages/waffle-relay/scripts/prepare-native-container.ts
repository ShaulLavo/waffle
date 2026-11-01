import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const template = join(root, "packages/waffle-relay/container/native");
const correction = "e81d4808976ed97f5e746150a23b88743f6fb94f";
const prebuildSha256 = "6340d0f657e37daaf168fe4bd77ad227653df3e3da52c96d1448a98dbfaf4c12";
const addonSha256 = "5592208da56aee0f53615b8d8c5d57c99a87618593c6343787ac9f92761daf1d";

export interface NativeContainerInputs {
  readonly runtime: { readonly path: string; readonly sha256: string };
  readonly relay: { readonly path: string; readonly sha256: string };
  readonly source: string;
  readonly prebuild: string;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function checkedArchive(input: NativeContainerInputs["runtime"]): Promise<void> {
  assert.match(input.sha256, /^[0-9a-f]{64}$/, "Expected an exact archive SHA-256");
  assert.equal(await sha256(input.path), input.sha256, "Archive checksum mismatch");
}
async function archiveFile(path: string, entry: string): Promise<string> {
  return (await execute("tar", ["-xOf", path, `package/${entry}`], { maxBuffer: 4 * 1024 * 1024 }))
    .stdout;
}
async function sourceFile(source: string, path: string): Promise<string> {
  return (await execute("git", ["show", `${source}:${path}`], { cwd: root })).stdout;
}
function metadata(text: string, name: string): { version: string; waffleHostInterface: number } {
  const value: unknown = JSON.parse(text);
  assert.ok(value && typeof value === "object" && "name" in value && value.name === name);
  assert.ok("version" in value && typeof value.version === "string");
  assert.match(value.version, /^0\.0\.\d+$/);
  assert.ok("waffleHostInterface" in value && value.waffleHostInterface === 1);
  return { version: value.version, waffleHostInterface: value.waffleHostInterface };
}

export async function verifyPairedReleaseArchives(input: Omit<NativeContainerInputs, "prebuild">) {
  assert.match(input.source, /^[0-9a-f]{40}$/, "Expected an exact source commit");
  await checkedArchive(input.runtime);
  await checkedArchive(input.relay);
  await execute("git", ["merge-base", "--is-ancestor", correction, input.source], { cwd: root });
  const runtime = metadata(await archiveFile(input.runtime.path, "package.json"), "waffle");
  const relay = metadata(await archiveFile(input.relay.path, "package.json"), "waffle-relay");
  assert.equal(runtime.version, relay.version, "Runtime and relay must be a paired release");
  for (const name of ["waffle", "waffle-relay"]) {
    const recorded = metadata(
      await sourceFile(input.source, `packages/${name}/package.json`),
      name,
    );
    assert.equal(runtime.version, recorded.version, "Archive version differs from source");
  }
  const prefix = "packages/waffle-relay/";
  const files = (
    await execute("git", ["ls-tree", "-r", "--name-only", input.source, `${prefix}src`], {
      cwd: root,
    })
  ).stdout
    .trim()
    .split("\n");
  for (const path of files) {
    assert.equal(
      await archiveFile(input.relay.path, path.slice(prefix.length)),
      await sourceFile(input.source, path),
      `Relay source mismatch at ${path}`,
    );
  }
  return {
    source: input.source,
    version: runtime.version,
    hostInterface: runtime.waffleHostInterface,
  };
}

export async function verifyNativeContainerInputs(input: NativeContainerInputs) {
  await checkedArchive({ path: input.prebuild, sha256: prebuildSha256 });
  const paired = await verifyPairedReleaseArchives(input);
  return {
    source: input.source,
    version: paired.version,
    hostInterface: paired.hostInterface,
    archives: { runtime: input.runtime.sha256, relay: input.relay.sha256 },
    native: { version: "1.6.11", prebuildSha256, addonSha256 },
    base: "docker.io/library/node@sha256:84f8a721625927ef3ccdf94509ecaea463a266d23f1b01a184061e84d3a6574d",
    qualification: "preparation-only",
  };
}

async function prepare(input: NativeContainerInputs, output: string): Promise<void> {
  const inputs = await verifyNativeContainerInputs(input);
  await execute("git", ["diff", "--exit-code", "HEAD", "--", template, import.meta.filename], {
    cwd: root,
  });
  const preparationSource = (
    await execute("git", ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim();
  const receipt = { ...inputs, preparationSource };
  await mkdir(output);
  try {
    await mkdir(join(output, "assets"));
    const assets: [string, string][] = [
      [input.runtime.path, "assets/waffle.tgz"],
      [input.relay.path, "assets/relay.tgz"],
      [input.prebuild, "assets/native.tar.gz"],
    ];
    for (const [source, destination] of assets) await copyFile(source, join(output, destination));
    await checkedArchive({ path: join(output, "assets/waffle.tgz"), sha256: input.runtime.sha256 });
    await checkedArchive({ path: join(output, "assets/relay.tgz"), sha256: input.relay.sha256 });
    await checkedArchive({ path: join(output, "assets/native.tar.gz"), sha256: prebuildSha256 });
    for (const file of ["Dockerfile", ".dockerignore", "relay.json"])
      await copyFile(join(template, file), join(output, file));
    await writeFile(join(output, "source-inputs.json"), JSON.stringify(receipt, null, 2) + "\n");
    await writeFile(
      join(output, "package.json"),
      JSON.stringify(
        {
          name: "waffle-relay-native-container",
          private: true,
          type: "module",
          dependencies: {
            waffle: "file:assets/waffle.tgz",
            "waffle-relay": "file:assets/relay.tgz",
            "@fails-components/webtransport": "1.6.11",
            "@fails-components/webtransport-transport-http3-quiche": "1.6.11",
          },
        },
        null,
        2,
      ) + "\n",
    );
    await execute(
      "npm",
      [
        "install",
        "--package-lock-only",
        "--omit=optional",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      {
        cwd: output,
        timeout: 90000,
        env: { ...process.env, npm_config_cache: join(output, ".npm-cache") },
      },
    );
    await rm(join(output, ".npm-cache"), { recursive: true, force: true });
    const files = [
      "assets/waffle.tgz",
      "assets/relay.tgz",
      "assets/native.tar.gz",
      "package.json",
      "package-lock.json",
      "relay.json",
      "source-inputs.json",
    ];
    const sums = await Promise.all(
      files.map(async (file) => `${await sha256(join(output, file))}  ${file}\n`),
    );
    await writeFile(join(output, "SHA256SUMS"), sums.join(""));
    process.stdout.write(
      JSON.stringify(
        {
          ...receipt,
          context: basename(output),
          lockSha256: await sha256(join(output, "package-lock.json")),
          configSha256: await sha256(join(output, "relay.json")),
        },
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const [runtime, runtimeHash, relay, relayHash, source, prebuild, output, ...extra] =
    process.argv.slice(2);
  assert.ok(
    runtime && runtimeHash && relay && relayHash && source && prebuild && output && !extra.length,
    "Usage: prepare-native-container.ts runtime.tgz runtime-sha256 relay.tgz relay-sha256 source-commit native.tar.gz new-context",
  );
  await prepare(
    {
      runtime: { path: resolve(runtime), sha256: runtimeHash },
      relay: { path: resolve(relay), sha256: relayHash },
      source,
      prebuild: resolve(prebuild),
    },
    resolve(output),
  );
}
