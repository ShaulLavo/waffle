import { expect, test } from "bun:test";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildNetwork, verifyNetwork } from "../tooling/build-network";
import { buildNodeModules, rewriteNodeImports } from "../build";

test("Node emission rewrites import syntax, never matching strings, comments or regexes", async () => {
  const root = await mkdtemp(
    join(
      process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()),
      "bun-wasm-emission-",
    ),
  );
  try {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "thing.with.dots.ts"), "export const value = 1;");
    await mkdir(join(root, "directory"));
    await writeFile(join(root, "directory", "index.ts"), "export const value = 1;");
    const code = `import { value } from './nested/thing.with.dots';
export { value as other } from "./nested/thing.with.dots.ts";
const later = import('./directory');
const ordinary = './nested/thing.with.dots';
// import('./nested/thing.with.dots')
const pattern = /import('keep')/;`;
    const emitted = rewriteNodeImports(code, join(root, "index.ts"), root);
    expect(emitted).toContain('from "./nested/thing.with.dots.js"');
    expect(emitted).toContain('import("./directory/index.js")');
    expect(emitted).toContain("const ordinary = './nested/thing.with.dots'");
    expect(emitted).toContain("// import('./nested/thing.with.dots')");
    expect(emitted).toContain("const pattern = /import('keep')/");
    expect(() => rewriteNodeImports("import './missing';", join(root, "index.ts"), root)).toThrow(
      "Cannot resolve",
    );
    expect(() => rewriteNodeImports("import '../outside';", join(root, "index.ts"), root)).toThrow(
      "outside package",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepare emits the same network asset beside source and Node loaders", async () => {
  const source = await Bun.file(
    new URL("../browser/net/network.wasm", import.meta.url),
  ).arrayBuffer();
  const prepared = await Bun.file(
    new URL("../dist/browser/net/network.wasm", import.meta.url),
  ).arrayBuffer();
  expect(new Uint8Array(prepared)).toEqual(new Uint8Array(source));
});

async function networkFixture(): Promise<string> {
  const root = await mkdtemp(
    join(
      process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()),
      "waffle-network-package-",
    ),
  );
  const source = new URL("../", import.meta.url).pathname;
  try {
    await mkdir(join(root, "tooling"));
    await mkdir(join(root, "browser/net"), { recursive: true });
    for (const path of [
      "Cargo.toml",
      "Cargo.lock",
      "rust-toolchain.toml",
      "network",
      "tooling/build-network.ts",
      "browser/net/module.ts",
    ])
      await cp(join(source, path), join(root, path), { recursive: true });
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function seedNetwork(root: string): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  await buildNetwork(root, async () => {
    const output = join(root, "built.wasm");
    await writeFile(output, bytes);
    return output;
  });
  return bytes;
}

async function forbidNetworkBuild(): Promise<never> {
  throw new Error("Cargo forbidden");
}

test("cached network artifact survives dist cleanup without calling Cargo", async () => {
  const root = await networkFixture();
  try {
    const bytes = await seedNetwork(root);
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist/stale"), "must disappear");
    await buildNodeModules(root, (path) => buildNetwork(path, forbidNetworkBuild));
    expect(existsSync(join(root, "dist/stale"))).toBe(false);
    expect(existsSync(join(root, "dist/browser/net/module.js"))).toBe(true);
    expect(
      new Uint8Array(await Bun.file(join(root, "dist/browser/net/network.wasm")).arrayBuffer()),
    ).toEqual(bytes);
    await verifyNetwork(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("network build runs once when absent and rejects missing compiler output", async () => {
  const root = await networkFixture();
  let builds = 0;
  const missing = join(root, "missing.wasm");
  try {
    await expect(
      buildNetwork(root, async () => {
        builds++;
        return missing;
      }),
    ).rejects.toThrow(missing);
    expect(builds).toBe(1);
    expect(existsSync(join(root, "browser/net/network.input-hash"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact verification rejects changed bytes and stale input without compiling", async () => {
  const root = await networkFixture();
  try {
    const bytes = await seedNetwork(root);
    await verifyNetwork(root);
    await writeFile(join(root, "browser/net/network.wasm"), bytes.slice(1));
    await expect(verifyNetwork(root)).rejects.toThrow("checksum");
    await seedNetwork(root);
    await writeFile(join(root, "network/src/queue.rs"), "changed input");
    await expect(verifyNetwork(root)).rejects.toThrow("input");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated network artifacts stay ignored and untracked", () => {
  const root = new URL("../", import.meta.url).pathname;
  const paths = [
    "browser/net/network.wasm",
    "browser/net/network.input-hash",
    "browser/net/network.sha256",
  ];
  expect(
    execFileSync("git", ["check-ignore"].concat(paths), { cwd: root, encoding: "utf8" })
      .trim()
      .split("\n"),
  ).toEqual(paths);
  expect(execFileSync("git", ["ls-files", "*.wasm"], { cwd: root, encoding: "utf8" })).toBe("");
});

test("CI preparation fails rather than launching Cargo for a missing artifact", async () => {
  const root = await networkFixture();
  try {
    const module = new URL("../tooling/build-network.ts", import.meta.url).href;
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { buildNetwork } from ${JSON.stringify(module)}; await buildNetwork(${JSON.stringify(root)});`,
      ],
      {
        env: { ...process.env, WAFFLE_NETWORK_PREBUILT: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const error = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(error).toContain("Cargo is forbidden in this job");
    expect(existsSync(join(root, "browser/net/network.wasm"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
