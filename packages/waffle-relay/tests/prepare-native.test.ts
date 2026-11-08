import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { prepareNativeRelay } from "../scripts/prepare-native.js";

const roots: string[] = [];
const packageRequire = createRequire(new URL("../package.json", import.meta.url));
const nativeName = "@fails-components/webtransport-transport-http3-quiche";
const mainName = "@fails-components/webtransport";
const bytes = Buffer.from("controlled prebuild bytes, never a loadable addon");

function fixture() {
  const scratch = mkdtempSync(
    join(
      process.env.WAFFLE_RELAY_TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()),
      "waffle-native-gate-",
    ),
  );
  roots.push(scratch);
  const native = join(scratch, "resolved-native");
  const main = join(scratch, "resolved-main");
  for (const [root, name] of [
    [native, nativeName],
    [main, mainName],
  ]) {
    if (!root || !name) throw new Error("Missing fixture package");
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name, version: "1.6.11", type: "module" }),
    );
    writeFileSync(
      join(root, "lib/index.js"),
      'throw new Error("Native packages must not execute during setup");',
    );
  }
  const artifact = join(native, "build/Release/webtransport.node");
  const calls: string[] = [];
  const install = (_entry: string, root: string) => {
    calls.push(root);
    mkdirSync(dirname(artifact), { recursive: true });
    writeFileSync(artifact, bytes);
  };
  const verify = async () => {
    calls.push("verify");
    expect(createHash("sha256").update(readFileSync(artifact)).digest("hex")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  };
  const options = {
    resolve: (specifier: string) => join(specifier === nativeName ? native : main, "lib/index.js"),
    install,
    verify,
  };
  return { scratch, native, main, artifact, calls, options };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("successful install command without its selected artifact is not readiness", async () => {
  const f = fixture();
  await expect(prepareNativeRelay({ ...f.options, install: () => {} })).rejects.toThrow(f.artifact);
  expect(f.calls).toEqual([]);
});

test("the real locked lifecycle accepts installer exit zero without checking the addon", () => {
  const f = fixture();
  const upstream = join(dirname(dirname(packageRequire.resolve(nativeName))), "build.js");
  cpSync(upstream, join(f.native, "build.js"));
  cpSync(join(dirname(upstream), "package.json"), join(f.native, "package.json"));
  const bin = join(f.scratch, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "prebuild-install"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const result = spawnSync(process.execPath, ["run", "--cwd", f.native, "build.js", "install"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("child process exited with code 0");
  expect(existsSync(f.artifact)).toBe(false);
});

test("successful package-manager installation without scripts does not promise an addon", () => {
  const f = fixture();
  const consumer = join(f.scratch, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "native-readiness-control",
      private: true,
      dependencies: { [nativeName]: `file:${f.native}` },
    }),
  );
  execFileSync(process.execPath, ["install", "--ignore-scripts"], {
    cwd: consumer,
    stdio: "pipe",
    env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(f.scratch, "bun-cache") },
  });
  expect(existsSync(join(consumer, "node_modules", nativeName, "package.json"))).toBe(true);
  expect(
    existsSync(join(consumer, "node_modules", nativeName, "build/Release/webtransport.node")),
  ).toBe(false);
});

test("verified preparation uses the exact resolved package, not a similarly named neighbor", async () => {
  const f = fixture();
  const neighbor = join(f.scratch, "node_modules", nativeName, "build/Release");
  mkdirSync(neighbor, { recursive: true });
  writeFileSync(join(neighbor, "webtransport.node"), bytes);
  await expect(prepareNativeRelay({ ...f.options, install: () => {} })).rejects.toThrow(f.artifact);
  await expect(prepareNativeRelay(f.options)).resolves.toBe(f.artifact);
  expect(f.calls).toEqual([f.native, "verify"]);
});

for (const packageName of ["native", "main"] as const) {
  test(`wrong ${packageName} package version fails before installation`, async () => {
    const f = fixture();
    writeFileSync(
      join(f[packageName], "package.json"),
      JSON.stringify({ name: packageName === "native" ? nativeName : mainName, version: "0.0.0" }),
    );
    await expect(prepareNativeRelay(f.options)).rejects.toThrow("1.6.11");
    expect(f.calls).toEqual([]);
  });
}

for (const shadow of [
  `build_${process.platform}_${process.arch}`,
  "build/Debug/webtransport.node",
]) {
  test(`a loader-selected shadow is rejected: ${shadow}`, async () => {
    const f = fixture();
    mkdirSync(join(f.native, shadow), { recursive: true });
    await expect(prepareNativeRelay(f.options)).rejects.toThrow("shadowed");
    expect(f.calls).toEqual([]);
  });
}

test("installer failure keeps its actual diagnostic and never calls verification", async () => {
  const f = fixture();
  const diagnostic = new Error("prebuild-install HTTP 503 controlled failure");
  await expect(
    prepareNativeRelay({
      ...f.options,
      install: () => {
        throw diagnostic;
      },
    }),
  ).rejects.toBe(diagnostic);
  expect(f.calls).toEqual([]);
});

for (const kind of ["empty", "directory"] as const) {
  test(`${kind} artifact cannot satisfy setup`, async () => {
    const f = fixture();
    const install = () => {
      mkdirSync(dirname(f.artifact), { recursive: true });
      if (kind === "directory") mkdirSync(f.artifact);
      else writeFileSync(f.artifact, "");
    };
    await expect(prepareNativeRelay({ ...f.options, install })).rejects.toThrow("nonempty file");
    expect(f.calls).toEqual([]);
  });
}

test("a verifier rejection is a setup failure, even when the installer succeeded", async () => {
  const f = fixture();
  await expect(
    prepareNativeRelay({
      ...f.options,
      verify: async () => {
        throw new Error("WebTransport native checksum mismatch");
      },
    }),
  ).rejects.toThrow("checksum mismatch");
  expect(f.calls).toEqual([f.native]);
});

test("preparation source uses only the standard N-API installer, not the lifecycle builder", () => {
  const source = readFileSync(resolve(import.meta.dir, "../scripts/prepare-native.ts"), "utf8");
  expect(source).toContain('resolve("prebuild-install/bin.js")');
  expect(source).toContain('"--runtime=napi"');
  expect(source).toContain('"--target=6"');
  expect(source).toContain("verify: verifyNativeInstallation");
  expect(source).not.toMatch(/build\.js|cmake|npx|https?:\/\//);
});

test("an installer cannot introduce a loader-selected shadow", async () => {
  const f = fixture();
  const install = (entry: string, root: string) => {
    f.options.install(entry, root);
    mkdirSync(join(root, `build_${process.platform}_${process.arch}`));
  };
  await expect(prepareNativeRelay({ ...f.options, install })).rejects.toThrow("shadowed");
  expect(f.calls).toEqual([f.native]);
});

test("a package with the expected version but the wrong name fails before installation", async () => {
  const f = fixture();
  writeFileSync(
    join(f.native, "package.json"),
    JSON.stringify({ name: "wrong-package", version: "1.6.11" }),
  );
  await expect(prepareNativeRelay(f.options)).rejects.toThrow(nativeName);
  expect(f.calls).toEqual([]);
});
