import { stageProgram } from "../tools/program-build-tools.ts";
import { cappedWasiFixture } from "../packages/python/scripts/wasi-artifact-fixture.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { buildNodeModules } from "../packages/waffle/build.ts";
import {
  assertGuestsReached,
  auditPackedImports,
  buildRelease,
  loadWorkspace,
  releaseAssetBase,
  releaseOrder,
  rewriteManifest,
  runtimeReleaseUrl,
  type ReleaseManifest,
  type ReleaseOptions,
} from "./program-release.ts";

const repository = resolve(import.meta.dirname, "..");
const runtimeVersion: unknown = JSON.parse(
  readFileSync(resolve(repository, "packages/waffle/package.json"), "utf8"),
).version;
if (typeof runtimeVersion !== "string") throw new Error("Runtime fixture needs a package version");
const runtimeUrl = runtimeReleaseUrl("ShaulLavo/waffle", runtimeVersion);
let runtimeSha256 = "";
let runtimeArchive = "";
const baseFamilies = ["coreutils", "findutils", "grep", "sed", "ripgrep", "base"];
const tag = "programs-v0.0.92";
const assetBase = `https://github.com/ShaulLavo/waffle/releases/download/${tag}`;

let scratch = "";

beforeAll(async () => {
  mkdirSync(resolve(repository, ".build"), { recursive: true });
  scratch = mkdtempSync(resolve(repository, ".build/program-release-"));
  await prepareRuntimeFixture();
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
    if (file.endsWith("-program.json")) continue;
    if (!file.endsWith(".wasm")) {
      writeFileSync(path, `stand-in notice for ${file}\n`);
      continue;
    }
    const input = resolve(packageRoot, ".build/fixture-input.wasm");
    mkdirSync(dirname(input), { recursive: true });
    writeFileSync(input, cappedWasiFixture);
    stageProgram(input, path);
    rmSync(input);
  }
}

async function prepareRuntimeFixture() {
  const root = resolve(scratch, "runtime-source");
  cpSync(resolve(repository, "packages/waffle"), root, {
    recursive: true,
    filter: (path) => !/\/(node_modules|dist|\.build|target|\.sources)$/.test(path),
  });
  // This suite executes package metadata, not networking. Keep its network fixture explicit.
  writeFileSync(
    resolve(root, "browser/net/network.wasm"),
    Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0),
  );
  await buildNodeModules(root, async () => {});
  const destination = resolve(scratch, "runtime-archive");
  mkdirSync(destination);
  execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--destination", destination], {
    cwd: root,
    env: { ...process.env, WAFFLE_NETWORK_PREBUILT: "1" },
    stdio: "pipe",
  });
  runtimeArchive = resolve(destination, `waffle-${runtimeVersion}.tgz`);
  runtimeSha256 = sha256(runtimeArchive);
}

function runtimeTarball() {
  return runtimeArchive;
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
    git(root, ["tag", tag]);
    out = resolve(scratch, "closure-out");
    manifest = await buildRelease({
      root,
      tag,
      version: "0.0.92",
      runtime: { url: runtimeUrl, sha256: runtimeSha256, tarball: await runtimeTarball() },
      families: ["base"],
      out,
    });
  }, 180_000);

  test("runtime fixture packaging preserves its explicit metadata-only network bytes", () => {
    const network = execFileSync("tar", [
      "-xzOf",
      runtimeArchive,
      "package/browser/net/network.wasm",
    ]);
    expect(network).toEqual(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  });

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
      version: runtimeVersion,
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
    expect(manifest.tagState).toBe("tagged");
    expect(manifest.assetBase).toBe(assetBase);
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
    expect(served.has(`/waffle-${runtimeVersion}.tgz`)).toBe(true);
    expect(check.imports).toContain("waffle-base");
    const wasm = manifest.packages.flatMap(packedGuests);
    expect(wasm).toHaveLength(26);
    const reached = new Set(check.wasm.map((item) => item.path));
    for (const path of wasm) expect(reached.has(path)).toBe(true);
    const guests = new Map(manifest.packages.map((item) => [item.name, item.guests]));
    const coreutilsGuests = [
      "dist/cat.wasm",
      "dist/clear.wasm",
      "dist/cp.wasm",
      "dist/cut.wasm",
      "dist/date.wasm",
      "dist/echo.wasm",
      "dist/env.wasm",
      "dist/head.wasm",
      "dist/ls.wasm",
      "dist/mkdir.wasm",
      "dist/mv.wasm",
      "dist/nl.wasm",
      "dist/rm.wasm",
      "dist/seq.wasm",
      "dist/sort.wasm",
      "dist/tail.wasm",
      "dist/touch.wasm",
      "dist/tr.wasm",
      "dist/uniq.wasm",
      "dist/wc.wasm",
      "dist/which.wasm",
    ];
    expect(guests.get("waffle-coreutils")?.descriptor).toEqual(coreutilsGuests);
    const coreutils = manifest.packages.find((item) => item.name === "waffle-coreutils");
    if (!coreutils) throw new Error("coreutils is missing from the release");
    expect(
      coreutils.artifacts
        .filter((file) => file.path.endsWith(".wasm"))
        .map((file) => file.path)
        .sort(),
    ).toEqual(coreutilsGuests);
    const echo = coreutils.artifacts.find((file) => file.path === "dist/echo.wasm");
    if (!echo) throw new Error("echo is missing from admitted coreutils assets");
    expect(check.wasm).toContainEqual({
      specifier: "waffle-coreutils",
      path: "node_modules/waffle-coreutils/dist/echo.wasm",
      sha256: echo.sha256,
    });
    expect(guests.get("waffle-base")).toEqual({ descriptor: [], staticReference: [] });
  });

  test("a symlinked output directory still proves guest containment in the real install", async () => {
    const linkedRoot = preparedFixture("symlink-output");
    const target = resolve(scratch, "actual-output");
    mkdirSync(target);
    const link = resolve(scratch, "linked-output");
    symlinkSync(target, link);
    const receipt = await buildRelease({
      ...(await fixtureOptions(linkedRoot, "unused-output")),
      out: link,
    });
    expect(new Set(receipt.installCheck.wasm.map((guest) => guest.path)).size).toBe(26);
    for (const guest of receipt.installCheck.wasm)
      expect(guest.path.startsWith("node_modules/")).toBe(true);
  }, 60_000);

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

async function fixtureOptions(root: string, name: string): Promise<ReleaseOptions> {
  return {
    root,
    tag,
    version: "0.0.92",
    runtime: { url: runtimeUrl, sha256: runtimeSha256, tarball: await runtimeTarball() },
    families: ["base"],
    out: resolve(scratch, `${name}-out`),
  };
}

function commitAll(root: string, message: string) {
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

/** A disposable acceptance program that records its pid and never finishes. */
function hungAcceptance(name: string) {
  const pidFile = resolve(scratch, `${name}.pid`);
  const script = resolve(scratch, `${name}-acceptance.ts`);
  writeFileSync(
    script,
    `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));\nawait Bun.sleep(600_000);\n`,
  );
  return { pidFile, script };
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function leftoverWork(out: string) {
  return existsSync(out) ? readdirSync(out).filter((name) => name.startsWith(".work-")) : [];
}

async function waitForFile(path: string, ms: number) {
  const deadline = Date.now() + ms;
  while (!existsSync(path) || !readFileSync(path, "utf8")) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(50);
  }
  return Number(readFileSync(path, "utf8"));
}

describe("review r621 refusals", () => {
  test("a family whose exports reach none of its admitted guests", async () => {
    const root = preparedFixture("zero-guests");
    writeFileSync(
      resolve(root, "packages/coreutils/src/index.ts"),
      'export const coreutils = { name: "coreutils", programs: [] };\nexport const coreutilsPrograms = coreutils.programs;\n',
    );
    commitAll(root, "export no guests");
    const release = buildRelease(await fixtureOptions(root, "zero-guests"));
    await expect(release).rejects.toThrow(
      /waffle-coreutils packs guests no export reaches: dist\/env\.wasm/,
    );
  }, 60_000);

  test("guest reach: descriptors, static references, pure JS and wrong bytes", () => {
    const expected = new Map([
      ["dist/a.wasm", "aa"],
      ["assets/b.wasm", "bb"],
    ]);
    const descriptor = [{ file: "dist/a.wasm", sha256: "aa" }];
    expect(assertGuestsReached("p", expected, descriptor, ["assets/b.wasm"])).toEqual({
      descriptor: ["dist/a.wasm"],
      staticReference: ["assets/b.wasm"],
    });
    expect(assertGuestsReached("js", new Map(), [], [])).toEqual({
      descriptor: [],
      staticReference: [],
    });
    expect(() => assertGuestsReached("p", expected, [], [])).toThrow(/no export reaches/);
    expect(() =>
      assertGuestsReached(
        "p",
        expected,
        [{ file: "dist/a.wasm", sha256: "xx" }],
        ["assets/b.wasm"],
      ),
    ).toThrow(/is not admitted/);
  });

  test("asset and runtime URLs are bound to their release tags and the runtime version", async () => {
    expect(releaseAssetBase("ShaulLavo/waffle", tag)).toBe(assetBase);
    expect(runtimeReleaseUrl("ShaulLavo/waffle", "0.0.91")).toBe(
      "https://github.com/ShaulLavo/waffle/releases/download/waffle-v0.0.91/waffle-0.0.91.tgz",
    );
    expect(() => releaseAssetBase("https://example.invalid/latest", tag)).toThrow(/owner\/name/);
    expect(() => runtimeReleaseUrl("ShaulLavo/waffle", "latest")).toThrow(/not exact/);
    const root = preparedFixture("urls");
    const options = await fixtureOptions(root, "urls");
    const withRuntime = (url: string) => ({ ...options, runtime: { ...options.runtime, url } });
    await expect(buildRelease(withRuntime("https://example.invalid/latest.tgz"))).rejects.toThrow(
      /not a waffle-v<version> release asset/,
    );
    const other = "https://example.invalid/releases/download/waffle-v0.0.91/waffle-0.0.91.tgz";
    await expect(buildRelease(withRuntime(other))).rejects.toThrow(/Runtime URL is not ours/);
    const older = runtimeReleaseUrl("ShaulLavo/waffle", "0.0.90");
    await expect(buildRelease(withRuntime(older))).rejects.toThrow(
      `Runtime URL names 0.0.90, its package is ${runtimeVersion}`,
    );
    await expect(
      buildRelease({ ...options, repository: "example.invalid/latest/x" }),
    ).rejects.toThrow(/owner\/name/);
    expect(leftoverWork(options.out)).toEqual([]);
  }, 60_000);

  test("an existing tag must name the packed commit; untagged is an explicit candidate", async () => {
    const root = preparedFixture("tags");
    const options = await fixtureOptions(root, "tags");
    await expect(buildRelease({ ...options, requireTag: true })).rejects.toThrow(/does not exist/);
    git(root, ["tag", tag]);
    writeFileSync(resolve(root, "packages/sed/README.md"), "different release source\n");
    commitAll(root, "move source past tag");
    await expect(buildRelease(options)).rejects.toThrow(
      /Tag programs-v0\.0\.92 names [0-9a-f]+, not packed/,
    );
    git(root, ["tag", "-d", tag]);
    const candidate = await buildRelease(options);
    expect(candidate.tagState).toBe("untagged-candidate");
  }, 60_000);

  test("a hung child times out, its process group is retired and staging removed", async () => {
    const root = preparedFixture("hung");
    const { pidFile, script } = hungAcceptance("hung");
    const options = {
      ...(await fixtureOptions(root, "hung")),
      acceptance: script,
      commandTimeoutMs: 8_000,
    };
    await expect(buildRelease(options)).rejects.toThrow(/interrupted or timed out/);
    const pid = await waitForFile(pidFile, 1);
    expect(alive(pid)).toBe(false);
    expect(leftoverWork(options.out)).toEqual([]);
  }, 60_000);

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`${signal} to the CLI retires its child before removing staging`, async () => {
      const name = `signal-${signal}`;
      const root = preparedFixture(name);
      const { pidFile, script } = hungAcceptance(name);
      const out = resolve(scratch, `${name}-out`);
      const args = ["--root", root, "--tag", tag, "--out", out, "--runtime-url", runtimeUrl]
        .concat(["--runtime-sha256", runtimeSha256, "--runtime-tarball", await runtimeTarball()])
        .concat(["--acceptance", script]);
      const cli = Bun.spawn(
        ["bun", resolve(import.meta.dirname, "program-release.ts")].concat(args),
        {
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      try {
        const pid = await waitForFile(pidFile, 30_000);
        cli.kill(signal);
        expect(await cli.exited).toBe(signal === "SIGTERM" ? 143 : 130);
        expect(await new Response(cli.stderr).text()).toContain(`Interrupted by ${signal}`);
        expect(alive(pid)).toBe(false);
        expect(leftoverWork(out)).toEqual([]);
      } finally {
        cli.kill("SIGKILL");
      }
    }, 60_000);
  }
});
