import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
import {
  auditPackedImports,
  buildRelease,
  loadWorkspace,
  releaseOrder,
  rewriteManifest,
  type ReleaseManifest,
} from "./program-release.ts";

const repository = resolve(import.meta.dirname, "..");
const runtimeUrl =
  "https://github.com/ShaulLavo/waffle/releases/download/waffle-v0.0.91/waffle-0.0.91.tgz";
const runtimeSha256 = "4802672be0fc458d3ef6ae4f5d4998c4c349cae790c6d99236d60a373f4faaea";
const baseFamilies = ["coreutils", "findutils", "grep", "sed", "ripgrep", "base"];
const tag = "programs-v0.0.92";
const assetBase = `https://github.com/ShaulLavo/waffle/releases/download/${tag}`;

let scratch = "";

beforeAll(() => {
  mkdirSync(resolve(repository, ".build"), { recursive: true });
  scratch = mkdtempSync(resolve(repository, ".build/program-release-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function git(root: string, args: string[]) {
  return execFileSync("git", ["-C", root].concat(args), { encoding: "utf8" }).trim();
}

/** Copies the real family sources and writes stand-in prepared outputs into a disposable repo. */
function preparedFixture(name: string) {
  const root = resolve(scratch, name);
  for (const family of baseFamilies) {
    cpSync(resolve(repository, "packages", family), resolve(root, "packages", family), {
      recursive: true,
      filter: (path) => !/\/(node_modules|dist|\.build|target|\.sources)$/.test(path),
    });
  }
  writeFileSync(resolve(root, ".gitignore"), "dist/\nnode_modules/\n");
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  for (const family of baseFamilies) writeArtifacts(resolve(root, "packages", family));
  return root;
}

function writeArtifacts(packageRoot: string) {
  const recipe = JSON.parse(readFileSync(resolve(packageRoot, "package-artifacts.json"), "utf8"));
  for (const file of recipe.files as string[]) {
    const path = resolve(packageRoot, file);
    mkdirSync(dirname(path), { recursive: true });
    const wasm = Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), Buffer.from(file)]);
    writeFileSync(path, file.endsWith(".wasm") ? wasm : `stand-in notice for ${file}\n`);
  }
}

async function runtimeTarball() {
  const local = process.env.WAFFLE_RUNTIME_TARBALL;
  if (local) return local;
  const path = resolve(scratch, "waffle-0.0.91.tgz");
  if (existsSync(path)) return path;
  const response = await fetch(runtimeUrl);
  if (!response.ok) throw new Error(`GET ${runtimeUrl}: ${response.status}`);
  writeFileSync(path, new Uint8Array(await response.arrayBuffer()));
  return path;
}

function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function packedGuests(item: ReleaseManifest["packages"][number]) {
  const guests = item.artifacts.filter((file) => file.path.endsWith(".wasm"));
  return guests.map((file) => `node_modules/${item.name}/${file.path}`);
}

function packedManifest(archive: string) {
  return JSON.parse(
    execFileSync("tar", ["-xzOf", archive, "package/package.json"], { encoding: "utf8" }),
  );
}

describe("base closure", () => {
  let root = "";
  let out = "";
  let manifest: ReleaseManifest;

  beforeAll(async () => {
    root = preparedFixture("closure");
    out = resolve(scratch, "closure-out");
    manifest = await buildRelease({
      root,
      tag,
      version: "0.0.92",
      assetBase,
      runtime: { url: runtimeUrl, sha256: runtimeSha256, tarball: await runtimeTarball() },
      families: ["base"],
      out,
    });
  }, 180_000);

  test("orders dependencies before base and records every asset", () => {
    expect(manifest.order.at(-1)).toBe("waffle-base");
    expect(manifest.order.toSorted()).toEqual([
      "waffle-base",
      "waffle-coreutils",
      "waffle-findutils",
      "waffle-grep",
      "waffle-ripgrep",
      "waffle-sed",
    ]);
    expect(manifest.runtime).toMatchObject({
      version: "0.0.91",
      url: runtimeUrl,
      sha256: runtimeSha256,
    });
    const sums = readFileSync(resolve(out, "assets/SHA256SUMS"), "utf8");
    for (const item of manifest.packages) {
      const archive = resolve(out, "assets", item.filename);
      expect(item.url).toBe(`${assetBase}/${item.filename}`);
      expect(sha256(archive)).toBe(item.sha256);
      expect(sums).toContain(`${item.sha256}  ${item.filename}\n`);
      expect(item.sourceTree).toBe(git(root, ["rev-parse", `HEAD:${item.sourceDirectory}`]));
    }
    expect(manifest.sourceCommit).toBe(git(root, ["rev-parse", "HEAD"]));
    expect(manifest.dirty).toBe(false);
  });

  test("packed manifests name only immutable asset URLs, never workspace or 0.0.0", () => {
    const urls = new Map(manifest.packages.map((item) => [item.name, item.url]));
    for (const item of manifest.packages) {
      const packed = packedManifest(resolve(out, "assets", item.filename));
      expect(packed.version).toBe("0.0.92");
      expect(packed.devDependencies).toBeUndefined();
      expect(packed.scripts).toBeUndefined();
      const text = JSON.stringify([packed.dependencies, packed.peerDependencies]);
      expect(text).not.toContain("workspace:");
      expect(text).not.toContain("0.0.0");
      for (const [name, spec] of Object.entries({
        ...packed.dependencies,
        ...packed.peerDependencies,
      })) {
        expect(spec).toBe(name === "waffle" ? runtimeUrl : urls.get(name));
      }
    }
    const base = packedManifest(resolve(out, "assets", "waffle-base-0.0.92.tgz"));
    expect(base.peerDependencies).toEqual({ waffle: runtimeUrl });
    expect(Object.keys(base.dependencies).toSorted()).toEqual([
      "waffle",
      "waffle-coreutils",
      "waffle-findutils",
      "waffle-grep",
      "waffle-ripgrep",
      "waffle-sed",
    ]);
  });

  test("real Bun install fetched every asset from the local server and reached every guest", () => {
    const check = manifest.installCheck;
    expect(check.registry).toBe("none");
    const served = new Set(check.requests);
    for (const item of manifest.packages) expect(served.has(`/${item.filename}`)).toBe(true);
    expect(served.has("/waffle-0.0.91.tgz")).toBe(true);
    expect(check.imports).toContain("waffle-base");
    const wasm = manifest.packages.flatMap(packedGuests);
    expect(wasm.length).toBeGreaterThan(20);
    const reached = new Set(check.wasm.map((item) => item.path));
    for (const path of wasm) expect(reached.has(path)).toBe(true);
  });

  test("never mutates the source checkout", () => {
    expect(git(root, ["status", "--porcelain"])).toBe("");
    const source = JSON.parse(readFileSync(resolve(root, "packages/base/package.json"), "utf8"));
    expect(source.version).toBe("0.0.0");
    expect(source.dependencies["waffle-coreutils"]).toBe("workspace:*");
  });
});

describe("refusals", () => {
  const workspace = new Map([
    ["waffle", { name: "waffle", directory: "waffle", root: "/x/waffle", manifest: {} }],
    ["waffle-a", { name: "waffle-a", directory: "a", root: "/x/a", manifest: {} }],
  ]);
  const urls = new Map([["waffle", runtimeUrl]]);

  test("workspace edge outside the closure", () => {
    const manifest = { name: "waffle-b", dependencies: { "waffle-a": "workspace:*" } };
    expect(() => rewriteManifest(manifest, "0.0.92", { workspace, urls })).toThrow(
      /outside the release closure/,
    );
  });

  test("unpublished 0.0.0, unknown workspace and local path specs", () => {
    const rewrite = (dependencies: Record<string, string>) =>
      rewriteManifest({ name: "waffle-b", dependencies }, "0.0.92", { workspace, urls });
    expect(() => rewrite({ other: "0.0.0" })).toThrow(/unpublished 0\.0\.0/);
    expect(() => rewrite({ other: "workspace:^" })).toThrow(/unresolved workspace edge/);
    expect(() => rewrite({ other: "file:../other" })).toThrow(/local path/);
  });

  test("peer * on the runtime becomes the runtime asset URL", () => {
    const manifest = {
      name: "waffle-b",
      peerDependencies: { waffle: "*" },
      devDependencies: { waffle: "workspace:*" },
    };
    const result = rewriteManifest(manifest, "0.0.92", { workspace, urls });
    expect(result.manifest.peerDependencies).toEqual({ waffle: runtimeUrl });
    expect(result.manifest.devDependencies).toBeUndefined();
    expect(result.stripped).toEqual(["devDependencies"]);
  });

  test("missing guests fail admission before packing", async () => {
    const root = preparedFixture("missing-guest");
    rmSync(resolve(root, "packages/grep/dist/grep.wasm"));
    const release = buildRelease({
      root,
      tag,
      version: "0.0.92",
      assetBase,
      runtime: { url: runtimeUrl, sha256: runtimeSha256, tarball: await runtimeTarball() },
      families: ["base"],
      out: resolve(scratch, "missing-guest-out"),
    });
    await expect(release).rejects.toThrow(/grep\.wasm|ENOENT/);
  }, 60_000);

  test("dirty sources and wrong runtime bytes", async () => {
    const root = preparedFixture("dirty");
    writeFileSync(resolve(root, "packages/sed/README.md"), "edited\n");
    const options = {
      root,
      tag,
      version: "0.0.92",
      assetBase,
      runtime: { url: runtimeUrl, sha256: runtimeSha256, tarball: await runtimeTarball() },
      families: ["base"],
      out: resolve(scratch, "dirty-out"),
    };
    await expect(buildRelease(options)).rejects.toThrow(/uncommitted changes/);
    git(root, ["checkout", "--", "packages/sed/README.md"]);
    const wrong = { ...options, runtime: { ...options.runtime, sha256: "0".repeat(64) } };
    await expect(buildRelease(wrong)).rejects.toThrow(/Runtime asset hash differs/);
  }, 60_000);

  test("cycles and undeclared runtime imports", () => {
    const root = resolve(scratch, "audit");
    mkdirSync(resolve(root, "src"), { recursive: true });
    writeFileSync(
      resolve(root, "src/index.ts"),
      'import { x } from "left-pad";\nexport const y = x;\n',
    );
    const manifest = { name: "waffle-c", exports: { ".": "./src/index.ts" } };
    expect(() => auditPackedImports(root, manifest)).toThrow(/imports undeclared left-pad/);
    expect(() =>
      auditPackedImports(root, { name: "waffle-c", exports: "./src/missing.ts" }),
    ).toThrow(/not packed/);
    const cycle = resolve(scratch, "cycle");
    for (const [directory, dependency] of [
      ["p", "waffle-q"],
      ["q", "waffle-p"],
    ] as const) {
      mkdirSync(resolve(cycle, "packages", directory), { recursive: true });
      const package_ = {
        name: `waffle-${directory}`,
        dependencies: { [dependency]: "workspace:*" },
      };
      writeFileSync(
        resolve(cycle, "packages", directory, "package.json"),
        JSON.stringify(package_),
      );
    }
    expect(() => releaseOrder(loadWorkspace(cycle), ["p"])).toThrow(/cycle/);
  });
});
