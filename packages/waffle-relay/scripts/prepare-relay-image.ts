import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeRelease } from "../container/native/release.ts";
import { publicationContext, root } from "./relay-image-contract.ts";

const [directory] = process.argv.slice(2);
assert.ok(directory, "Expected task-owned scratch directory");
const context = publicationContext(process.env);
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  context.sourceHead,
);
const spec = context.specification;
const qualification = join(directory, "qualification");
await mkdir(join(qualification, "tests"), { recursive: true });
async function download(url: string, path: string): Promise<void> {
  execFileSync("curl", [
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "--max-time",
    "120",
    url,
    "--output",
    path,
  ]);
}
if (spec.variant === "native") {
  const runtime = join(directory, "waffle.tgz");
  const relay = join(directory, "relay.tgz");
  const prebuild = join(directory, "native.tar.gz");
  await download(nativeRelease.runtime.url, runtime);
  await download(nativeRelease.relay.url, relay);
  await download(
    "https://github.com/fails-components/webtransport/releases/download/v1.6.11/webtransport-transport-http3-quiche-v1.6.11-napi-v6-linux-x64.tar.gz",
    prebuild,
  );
  const receipt = execFileSync(process.execPath, [
    join(root, "packages/waffle-relay/scripts/prepare-native-container.ts"),
    runtime,
    nativeRelease.runtime.sha256,
    relay,
    nativeRelease.relay.sha256,
    nativeRelease.source,
    prebuild,
    join(directory, "context"),
  ]);
  await writeFile(join(directory, "preparation.json"), receipt);
  await copyFile(join(root, spec.template, "release.ts"), join(qualification, "release.ts"));
} else {
  const output = join(directory, "context");
  await mkdir(join(output, "assets"), { recursive: true });
  for (const file of [
    "Dockerfile",
    ".dockerignore",
    "package.json",
    "package-lock.json",
    "relay.json",
  ])
    await copyFile(join(root, spec.template, file), join(output, file));
  for (const name of ["waffle-0.0.109.tgz", "waffle-relay-0.0.109.tgz"])
    await download(
      `https://github.com/ShaulLavo/waffle/releases/download/waffle-v0.0.109/${name}`,
      join(output, "assets", name),
    );
}
await copyFile(join(root, spec.template, "verify.ts"), join(qualification, "verify.ts"));
await writeFile(
  join(qualification, "tests/tcp-native-fixture.ts"),
  execFileSync("git", ["show", `${spec.source}:packages/waffle-relay/tests/tcp-native-fixture.ts`]),
);
await writeFile(join(directory, "selection.json"), JSON.stringify(context, null, 2) + "\n");
