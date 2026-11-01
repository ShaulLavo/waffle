import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { serveConfig } from "../src/cli-config.js";
import {
  verifyNativeContainerInputs,
  verifyPairedReleaseArchives,
} from "../scripts/prepare-native-container.ts";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const native = resolve(import.meta.dirname, "../container/native");
const read = (path: string) => readFile(join(native, path), "utf8");

describe("native container preparation", () => {
  test("adds only a separate listener while keeping the WS deny-all policy", async () => {
    const ordinary = JSON.parse(await readFile(join(native, "../relay.json"), "utf8"));
    const selected = JSON.parse(await read("relay.json"));
    const { webtransport, ...tcp } = selected.tcp;
    expect({ ...selected, tcp }).toEqual(ordinary);
    expect(webtransport).toEqual({
      bind: { host: "0.0.0.0", port: 4433 },
      advertisedUrl: "https://waffle-relay-public.sprockt.dev:4433/v1/tcp/wt",
      certificate: "rotating-hash",
    });
    const config = await serveConfig(["serve", "--config", join(native, "relay.json")], {
      WAFFLE_RELAY_TOKEN_SECRET: randomBytes(32).toString("hex"),
    });
    expect(config.listen).toEqual({ host: "0.0.0.0", port: 8787 });
    expect(config.options.tcp?.destinations).toEqual([]);
    expect(config.options.tcp?.issuer).toBeUndefined();
    expect(config.options.tcp).toHaveProperty("webtransport", webtransport);
  });
  test("checks archives and addon before load and keeps final app files root-owned", async () => {
    const dockerfile = await read("Dockerfile");
    expect(dockerfile).toContain("npm ci --omit=optional --ignore-scripts");
    expect(dockerfile.indexOf("sha256sum --check SHA256SUMS")).toBeLessThan(
      dockerfile.indexOf("npm ci"),
    );
    expect(dockerfile).toContain(
      "6340d0f657e37daaf168fe4bd77ad227653df3e3da52c96d1448a98dbfaf4c12",
    );
    expect(dockerfile).toContain(
      "5592208da56aee0f53615b8d8c5d57c99a87618593c6343787ac9f92761daf1d",
    );
    expect(dockerfile).toContain("USER 1000:1000");
    expect(dockerfile).not.toContain("--chown");
    expect(dockerfile).toContain("EXPOSE 8787/tcp 4433/udp");
    expect(dockerfile).toContain("STOPSIGNAL SIGTERM");
    expect(dockerfile).not.toContain("4433:4433");
    expect(dockerfile).not.toContain("0.0.109");
    const entry = await readFile(join(native, "../../src/node-webtransport.ts"), "utf8");
    expect(entry.indexOf("await verifyNativeInstallation()")).toBeLessThan(
      entry.indexOf('import("./node-webtransport-internal.js")'),
    );
  });
});

async function fixture(directory: string) {
  const source = (await execute("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const runtime = join(directory, "runtime");
  const relay = join(directory, "relay");
  await mkdir(join(runtime, "package"), { recursive: true });
  await mkdir(join(relay, "package"), { recursive: true });
  const packages: [string, string][] = [
    ["waffle", runtime],
    ["waffle-relay", relay],
  ];
  for (const [name, path] of packages) {
    const text = (
      await execute("git", ["show", `${source}:packages/${name}/package.json`], { cwd: root })
    ).stdout;
    await writeFile(join(path, "package/package.json"), text);
  }
  const sourceArchive = join(directory, "source.tar");
  await execute(
    "git",
    ["archive", source, "packages/waffle-relay/src", "--output", sourceArchive],
    { cwd: root },
  );
  await execute("tar", [
    "-xf",
    sourceArchive,
    "--strip-components=2",
    "-C",
    join(relay, "package"),
  ]);
  async function pack(path: string) {
    const archive = path + ".tgz";
    await execute("tar", ["-czf", archive, "-C", path, "package"]);
    return {
      path: archive,
      sha256: createHash("sha256")
        .update(await readFile(archive))
        .digest("hex"),
    };
  }
  return { source, runtime: await pack(runtime), relay: await pack(relay) };
}

test("archive tuple checks real source and rejects mismatched bytes, versions and old source", async () => {
  const directory = await mkdtemp(
    join(process.env.WAFFLE_RELAY_TMPDIR ?? "/work/tmp", "waffle-native-prep-"),
  );
  try {
    const input = await fixture(directory);
    expect(await verifyPairedReleaseArchives(input)).toMatchObject({
      source: input.source,
      hostInterface: 1,
    });
    await expect(
      verifyPairedReleaseArchives({
        ...input,
        runtime: { ...input.runtime, sha256: "0".repeat(64) },
      }),
    ).rejects.toThrow("checksum");
    await expect(
      verifyPairedReleaseArchives({ ...input, source: "5f3d329f35be618e5b4d822c0ee933bbfd9a10f5" }),
    ).rejects.toThrow();
    const prebuild = join(directory, "bad-native.tar.gz");
    await writeFile(prebuild, "not a native release archive");
    await expect(verifyNativeContainerInputs({ ...input, prebuild })).rejects.toThrow("checksum");
    const relayManifest = join(directory, "relay/package/package.json");
    const manifest = JSON.parse(await readFile(relayManifest, "utf8"));
    await writeFile(relayManifest, JSON.stringify({ ...manifest, version: "0.0.0" }));
    await execute("tar", ["-czf", input.relay.path, "-C", join(directory, "relay"), "package"]);
    const mismatch = createHash("sha256")
      .update(await readFile(input.relay.path))
      .digest("hex");
    await expect(
      verifyPairedReleaseArchives({ ...input, relay: { ...input.relay, sha256: mismatch } }),
    ).rejects.toThrow("paired release");
    await writeFile(relayManifest, JSON.stringify(manifest));
    await writeFile(
      join(directory, "relay/package/src/webtransport-address.ts"),
      "unqualified source",
    );
    await execute("tar", ["-czf", input.relay.path, "-C", join(directory, "relay"), "package"]);
    const sha256 = createHash("sha256")
      .update(await readFile(input.relay.path))
      .digest("hex");
    await expect(
      verifyPairedReleaseArchives({ ...input, relay: { ...input.relay, sha256 } }),
    ).rejects.toThrow("Relay source mismatch");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
