import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { assertOnePhysicalRuntime } from "./program-release.ts";
import { buildRebind, type RebindOptions } from "./program-rebind.ts";

const repository = resolve(import.meta.dirname, "..");
const fromTag = "programs-v0.0.13";
const targetTag = "programs-v0.0.14";
const sourceRuntimeUrl =
  "https://github.com/ShaulLavo/waffle/releases/download/waffle-v0.0.105/waffle-0.0.105.tgz";
const targetRuntimeUrl =
  "https://github.com/ShaulLavo/waffle/releases/download/waffle-v0.0.106/waffle-0.0.106.tgz";
let scratch = "";

function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function git(root: string, args: string[]) {
  return execFileSync("git", ["-C", root].concat(args), { encoding: "utf8" }).trim();
}

function commit(root: string, message: string) {
  git(root, ["add", "-A"]);
  git(root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@invalid",
    "commit",
    "-qm",
    message,
  ]);
}

function pack(root: string, archive: string) {
  mkdirSync(dirname(archive), { recursive: true });
  execFileSync("bun", ["pm", "pack", "--quiet", "--ignore-scripts", "--filename", archive], {
    cwd: root,
  });
}

function packageManifest(
  name: string,
  dependencies: Record<string, string>,
  peers: Record<string, string>,
) {
  return {
    name,
    version: "0.0.13",
    type: "module",
    exports: { ".": "./index.js" },
    dependencies,
    peerDependencies: peers,
  };
}

function writePackage(root: string, directory: string, manifest: object, artifact: boolean) {
  const packageRoot = resolve(root, "packages", directory);
  mkdirSync(resolve(packageRoot, "dist"), { recursive: true });
  const packedManifest = {
    ...manifest,
    files: artifact ? ["dist", "index.js", "package-artifacts.json"] : ["index.js"],
  };
  writeFileSync(
    resolve(packageRoot, "package.json"),
    `${JSON.stringify(packedManifest, null, 2)}\n`,
  );
  const program = artifact
    ? 'export const guest = new URL("./dist/tool.wasm", import.meta.url);\n'
    : "export const program = { name: import.meta.url };\n";
  writeFileSync(resolve(packageRoot, "index.js"), program);
  if (artifact) {
    writeFileSync(
      resolve(packageRoot, "package-artifacts.json"),
      JSON.stringify({ files: ["dist/tool.wasm"] }, null, 2) + "\n",
    );
  }
}

function sourcePackage(
  root: string,
  directory: string,
  name: string,
  artifact: boolean,
  archiveDir: string,
) {
  const packageRoot = resolve(root, "packages", directory);
  const archive = resolve(archiveDir, `${name}-0.0.13.tgz`);
  pack(packageRoot, archive);
  const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  const files = artifact
    ? [{ path: "dist/tool.wasm", bytes: 8, sha256: sha256(resolve(packageRoot, "dist/tool.wasm")) }]
    : [];
  return {
    name,
    sourceDirectory: `packages/${directory}`,
    sourceTree: git(root, ["rev-parse", `HEAD:packages/${directory}`]),
    sourceVersion: "0.0.13",
    version: "0.0.13",
    filename: `${name}-0.0.13.tgz`,
    url: `https://github.com/ShaulLavo/waffle/releases/download/${fromTag}/${name}-0.0.13.tgz`,
    bytes: readFileSync(archive).length,
    sha256: sha256(archive),
    closureDependencies:
      name === "waffle-base"
        ? { waffle: sourceRuntimeUrl, "waffle-child": "asset" }
        : { waffle: sourceRuntimeUrl },
    registryDependencies: {},
    strippedFields: [],
    typeOnlyUndeclared: [],
    artifacts: files,
    guests: artifact
      ? { descriptor: [], staticReference: ["dist/tool.wasm"] }
      : { descriptor: [], staticReference: [] },
    packageJson,
  };
}

function createFixture(
  config: { mutate?: (root: string, archiveRoot: string) => void; rawArchive?: boolean } = {},
) {
  const root = mkdtempSync(resolve(scratch, "historical-"));
  const assets = resolve(root, "source-assets");
  const archiveRoot = resolve(root, "archive-work");
  mkdirSync(assets, { recursive: true });
  mkdirSync(archiveRoot, { recursive: true });
  mkdirSync(resolve(root, "tools"), { recursive: true });
  writeFileSync(
    resolve(root, "tools/program-package.ts"),
    'await Bun.write("historical-marker", "used\\n");\n',
  );
  writePackage(
    root,
    "child",
    packageManifest("waffle-child", {}, { waffle: sourceRuntimeUrl }),
    true,
  );
  writePackage(
    root,
    "base",
    packageManifest(
      "waffle-base",
      {
        waffle: sourceRuntimeUrl,
        "waffle-child":
          "https://github.com/ShaulLavo/waffle/releases/download/programs-v0.0.13/waffle-child-0.0.13.tgz",
      },
      { waffle: sourceRuntimeUrl },
    ),
    false,
  );
  writeFileSync(
    resolve(root, ".gitignore"),
    "source-assets/\narchive-work/\nruntime/\ndist/\npackages/*/dist/\nout/\n*-out/\nhistorical-marker\nwrong-runtime/\n",
  );
  git(root, ["init", "-q"]);
  commit(root, "source");
  writeFileSync(
    resolve(root, "packages/child/dist/tool.wasm"),
    Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0),
  );
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(root, ["tag", fromTag]);
  const child = sourcePackage(root, "child", "waffle-child", true, archiveRoot);
  const base = sourcePackage(root, "base", "waffle-base", false, archiveRoot);
  if (config.mutate) config.mutate(root, archiveRoot);
  const packages = [child, base].map((item) => {
    const archive = resolve(archiveRoot, item.filename);
    cpSync(archive, resolve(assets, item.filename));
    return {
      ...item,
      bytes: readFileSync(archive).length,
      sha256: sha256(archive),
    };
  });
  const sourceCommit = git(root, ["rev-parse", "HEAD"]);
  const manifest = {
    schema: "waffle-program-release/1",
    operation: "release",
    tag: fromTag,
    version: "0.0.13",
    sourceCommit,
    dirty: false,
    tagState: "tagged",
    assetBase: `https://github.com/ShaulLavo/waffle/releases/download/${fromTag}`,
    runtime: {
      name: "waffle",
      version: "0.0.105",
      url: sourceRuntimeUrl,
      bytes: 1,
      sha256: "old-runtime",
    },
    order: packages.map((item) => item.name),
    packages,
    installCheck: { registry: "none", requests: [], imports: [], wasm: [], runtimeRoots: 1 },
  };
  const manifestPath = resolve(assets, "program-release.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    resolve(assets, "SHA256SUMS"),
    packages.map((item) => `${item.sha256}  ${item.filename}\n`).join(""),
  );
  const runtimeRoot = resolve(root, "runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(
    resolve(runtimeRoot, "package.json"),
    JSON.stringify(
      { name: "waffle", version: "0.0.106", type: "module", exports: { ".": "./index.js" } },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(resolve(runtimeRoot, "index.js"), "export const runtime = true;\n");
  const runtimeArchive = resolve(runtimeRoot, "waffle-0.0.106.tgz");
  pack(runtimeRoot, runtimeArchive);
  const out = resolve(root, "out");
  const fixtureOptions: RebindOptions = {
    root: repository,
    fromTag,
    fromManifestSha256: sha256(manifestPath),
    tag: targetTag,
    repository: "ShaulLavo/waffle",
    runtime: { url: targetRuntimeUrl, sha256: sha256(runtimeArchive), tarball: runtimeArchive },
    historicalRoot: root,
    out,
    requireTag: false,
    fromAssets: assets,
    commandTimeoutMs: 60_000,
  };
  return { root, assets, archiveRoot, manifestPath, runtimeArchive, out, options: fixtureOptions };
}

function updateSourceMetadata(fixture: ReturnType<typeof createFixture>) {
  const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8"));
  for (const item of manifest.packages) {
    const archive = resolve(fixture.assets, item.filename);
    item.bytes = readFileSync(archive).length;
    item.sha256 = sha256(archive);
  }
  writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    resolve(fixture.assets, "SHA256SUMS"),
    manifest.packages
      .map((item: { sha256: string; filename: string }) => `${item.sha256}  ${item.filename}\n`)
      .join(""),
  );
  fixture.options = { ...fixture.options, fromManifestSha256: sha256(fixture.manifestPath) };
}

function repackSourceArchive(
  fixture: ReturnType<typeof createFixture>,
  name: string,
  edit: (root: string) => void,
) {
  const extracted = resolve(fixture.root, `mutate-${name}`);
  execFileSync("tar", ["-xzf", resolve(fixture.assets, `${name}-0.0.13.tgz`), "-C", fixture.root]);
  const packageRoot = resolve(fixture.root, "package");
  edit(packageRoot);
  const archive = resolve(fixture.archiveRoot, `${name}-mutated.tgz`);
  pack(packageRoot, archive);
  cpSync(archive, resolve(fixture.assets, `${name}-0.0.13.tgz`));
  rmSync(packageRoot, { recursive: true, force: true });
  rmSync(extracted, { recursive: true, force: true });
  updateSourceMetadata(fixture);
}

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

describe("program peer rebind", () => {
  test("rebinds metadata, preserves payloads, and proves one runtime", async () => {
    scratch = mkdtempSync("/work/tmp/program-rebind-test-");
    const fixture = createFixture();
    const manifest = await buildRebind(fixture.options);
    expect(manifest.operation).toBe("peer-rebind");
    expect(manifest.version).toBe("0.0.14");
    expect(manifest.runtime.version).toBe("0.0.106");
    expect(manifest.sourceCommit).toBe(git(fixture.root, ["rev-parse", "HEAD"]));
    expect(manifest.rebind?.from.manifestSha256).toBe(fixture.options.fromManifestSha256);
    expect(manifest.installCheck.runtimeRoots).toBe(1);
    expect(manifest.packages.map((item) => item.version)).toEqual(["0.0.14", "0.0.14"]);
    expect(manifest.packages[0]?.changedFiles).toEqual(["package.json"]);
    expect(manifest.packages[0]?.original?.version).toBe("0.0.13");
    expect(existsSync(resolve(fixture.root, "historical-marker"))).toBe(true);
    expect(readdirNames(fixture.out)).toEqual(["assets"]);
    const baseJson = JSON.parse(
      execFileSync(
        "tar",
        ["-xzOf", resolve(fixture.out, "assets/waffle-base-0.0.14.tgz"), "package/package.json"],
        { encoding: "utf8" },
      ),
    );
    expect(baseJson.dependencies.waffle).toBe(targetRuntimeUrl);
    expect(baseJson.dependencies["waffle-child"]).toContain("programs-v0.0.14");
    expect(baseJson.version).toBe("0.0.14");
  }, 60_000);

  test("refuses a wrong source manifest hash", async () => {
    scratch = mkdtempSync("/work/tmp/program-rebind-test-");
    const fixture = createFixture();
    await expect(
      buildRebind({ ...fixture.options, fromManifestSha256: "0".repeat(64) }),
    ).rejects.toThrow(/Source manifest hash differs/);
  });

  test("uses the supplied runtime archive and rejects wrong hash or package version", async () => {
    scratch = mkdtempSync("/work/tmp/program-rebind-test-");
    const fixture = createFixture();
    const manifest = await buildRebind(fixture.options);
    expect(manifest.runtime.sha256).toBe(sha256(fixture.runtimeArchive));
    await expect(
      buildRebind({
        ...fixture.options,
        out: resolve(fixture.root, "wrong-hash-out"),
        runtime: { ...fixture.options.runtime, sha256: "0".repeat(64) },
      }),
    ).rejects.toThrow(/Runtime asset hash differs/);

    const wrongRuntime = resolve(fixture.root, "wrong-runtime");
    mkdirSync(wrongRuntime, { recursive: true });
    writeFileSync(
      resolve(wrongRuntime, "package.json"),
      JSON.stringify(
        { name: "waffle", version: "0.0.105", type: "module", exports: { ".": "./index.js" } },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(resolve(wrongRuntime, "index.js"), "export const runtime = false;\n");
    const wrongArchive = resolve(wrongRuntime, "waffle-0.0.105.tgz");
    pack(wrongRuntime, wrongArchive);
    await expect(
      buildRebind({
        ...fixture.options,
        out: resolve(fixture.root, "wrong-version-out"),
        runtime: { url: targetRuntimeUrl, sha256: sha256(wrongArchive), tarball: wrongArchive },
      }),
    ).rejects.toThrow(/Runtime URL names 0.0.106, its package is 0.0.105/);
  }, 60_000);

  test("refuses changed tracked bytes and unexplained files", async () => {
    scratch = mkdtempSync("/work/tmp/program-rebind-test-");
    const tracked = createFixture();
    repackSourceArchive(tracked, "waffle-child", (root) =>
      writeFileSync(resolve(root, "index.js"), "changed\n"),
    );
    await expect(buildRebind(tracked.options)).rejects.toThrow(/changed tracked index.js/);

    const extra = createFixture();
    repackSourceArchive(extra, "waffle-base", (root) => {
      const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
      manifest.files.push("extra.txt");
      writeFileSync(resolve(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      writeFileSync(resolve(root, "extra.txt"), "extra\n");
    });
    await expect(buildRebind(extra.options)).rejects.toThrow(/unexplained file extra.txt/);
  }, 60_000);

  test("refuses a missing artifact and a failed identity repack", async () => {
    scratch = mkdtempSync("/work/tmp/program-rebind-test-");
    const missing = createFixture();
    repackSourceArchive(missing, "waffle-child", (root) => rmSync(resolve(root, "dist/tool.wasm")));
    await expect(buildRebind(missing.options)).rejects.toThrow(/missing artifact dist\/tool.wasm/);

    const failed = createFixture();
    execFileSync("tar", [
      "-xzf",
      resolve(failed.assets, "waffle-base-0.0.13.tgz"),
      "-C",
      failed.root,
    ]);
    const raw = resolve(failed.archiveRoot, "raw.tgz");
    execFileSync("tar", ["-czf", raw, "-C", failed.root, "package"]);
    cpSync(raw, resolve(failed.assets, "waffle-base-0.0.13.tgz"));
    rmSync(resolve(failed.root, "package"), { recursive: true, force: true });
    updateSourceMetadata(failed);
    await expect(buildRebind(failed.options)).rejects.toThrow(/identity repack differs/);
  }, 60_000);

  test("refuses an old URL, a dirty historical root, and a tag naming another commit", async () => {
    scratch = mkdtempSync("/work/tmp/program-rebind-test-");
    const oldUrl = createFixture();
    repackSourceArchive(oldUrl, "waffle-base", (root) => {
      const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
      manifest.metadata = `programs-v0.0.13/${manifest.name}`;
      writeFileSync(resolve(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    });
    await expect(buildRebind(oldUrl.options)).rejects.toThrow(/kept its old program URL/);

    const dirty = createFixture();
    writeFileSync(resolve(dirty.root, "dirty.txt"), "dirty\n");
    await expect(buildRebind(dirty.options)).rejects.toThrow(/Historical root is dirty/);

    const wrongTag = createFixture();
    const tree = git(wrongTag.root, ["rev-parse", "HEAD^{tree}"]);
    const otherCommit = execFileSync(
      "git",
      ["-C", wrongTag.root, "commit-tree", tree, "-p", "HEAD"],
      {
        encoding: "utf8",
        input: "different tag commit\n",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "fixture",
          GIT_AUTHOR_EMAIL: "fixture@invalid",
          GIT_COMMITTER_NAME: "fixture",
          GIT_COMMITTER_EMAIL: "fixture@invalid",
        },
      },
    ).trim();
    git(wrongTag.root, ["tag", targetTag, otherCommit]);
    await expect(buildRebind(wrongTag.options)).rejects.toThrow(/names .* not historical/);
  }, 60_000);

  test("shared runtime checker rejects two physical runtimes", () => {
    scratch = mkdtempSync("/work/tmp/program-rebind-test-");
    const consumer = resolve(scratch, "consumer");
    mkdirSync(resolve(consumer, "node_modules/waffle"), { recursive: true });
    mkdirSync(resolve(consumer, "node_modules/child/node_modules/waffle"), { recursive: true });
    const packageJson = JSON.stringify({ name: "waffle", version: "0.0.106" });
    writeFileSync(resolve(consumer, "node_modules/waffle/package.json"), packageJson);
    writeFileSync(
      resolve(consumer, "node_modules/child/node_modules/waffle/package.json"),
      packageJson,
    );
    expect(() => assertOnePhysicalRuntime(consumer, "0.0.106")).toThrow(
      /one physical waffle runtime/,
    );
  });
});

function readdirNames(path: string) {
  return execFileSync("find", [path, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\\n"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
}
