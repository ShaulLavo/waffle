import { afterEach, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { command, identity, provision, sha256, verify } from "../scripts/native-oracle.ts";
import { processState } from "./fixtures/process-state.ts";

const roots: string[] = [];
const signal = () => AbortSignal.timeout(5000);
const pinned = requiredEnvironment("NATIVE_CURL");
const directory = dirname(pinned);
const scratchRoot = requiredEnvironment("CURL_NATIVE_SCRATCH_ROOT");
function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const expected = await identity(signal());
function scratch() {
  mkdirSync(scratchRoot, { recursive: true });
  const root = mkdtempSync(join(scratchRoot, "control-"));
  roots.push(root);
  return root;
}
function copiedCache() {
  const root = scratch();
  const cache = join(root, "oracle");
  cpSync(directory, cache, { recursive: true });
  return { root, cache };
}
function receipt(cache: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(join(cache, "receipt.json"), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid test receipt");
  return Object.fromEntries(Object.entries(value));
}
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

test("validated cache returns the actual pinned HTTP-only binary", async () => {
  const result = await verify(directory, expected, signal());
  expect(result.path).toBe(pinned);
  expect(result.binarySha256).toBe(sha256(readFileSync(pinned)));
  expect(result.version).toContain("Protocols: http\n");
  expect(result.version).not.toContain("SSL");
});

test("corrupt executable cache is rejected before it can create a marker", async () => {
  const { root, cache } = copiedCache();
  const marker = join(root, "executed");
  writeFileSync(join(cache, "curl"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  await expect(verify(cache, expected, signal())).rejects.toThrow(
    "binary digest mismatch before execution",
  );
  expect(existsSync(marker)).toBe(false);
});

test("changed source/compiler identity is rejected before payload execution", async () => {
  const { root, cache } = copiedCache();
  const value = receipt(cache);
  value.inputs = { compiler: "different", source: "different" };
  writeFileSync(join(cache, "receipt.json"), JSON.stringify(value));
  const marker = join(root, "executed");
  writeFileSync(join(cache, "curl"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  await expect(verify(cache, expected, signal())).rejects.toThrow("cache identity mismatch");
  expect(existsSync(marker)).toBe(false);
});

test("wrong recorded version and protocols fail closed", async () => {
  const { cache } = copiedCache();
  const value = receipt(cache);
  value.version = "curl 8.22.0 (x86_64-pc-linux-gnu) libcurl/8.22.0\nProtocols: http\n";
  writeFileSync(join(cache, "receipt.json"), JSON.stringify(value));
  await expect(verify(cache, expected, signal())).rejects.toThrow("Unexpected oracle version");
  value.version = "curl 8.23.0 (x86_64-pc-linux-gnu) libcurl/8.23.0\nProtocols: http https\n";
  writeFileSync(join(cache, "receipt.json"), JSON.stringify(value));
  await expect(verify(cache, expected, signal())).rejects.toThrow("HTTP only");
});

test("missing receipt and symlink payload are not executable cache hits", async () => {
  const { root, cache } = copiedCache();
  rmSync(join(cache, "receipt.json"));
  await expect(verify(cache, expected, signal())).rejects.toThrow();
  cpSync(join(directory, "receipt.json"), join(cache, "receipt.json"));
  rmSync(join(cache, "curl"));
  symlinkSync(pinned, join(cache, "curl"));
  await expect(verify(cache, expected, signal())).rejects.toThrow("regular file");
  symlinkSync(directory, join(root, "symlink-cache"));
  await expect(verify(join(root, "symlink-cache"), expected, signal())).rejects.toThrow(
    "directory is not regular",
  );
});

test("bad source checksum rejects before extraction/build and removes scratch", async () => {
  const root = scratch();
  const archive = join(root, "wrong.tar.xz");
  writeFileSync(archive, "not the pinned source");
  const previous = process.env.CURL_NATIVE_SOURCE_ARCHIVE;
  process.env.CURL_NATIVE_SOURCE_ARCHIVE = archive;
  try {
    await expect(
      provision(join(root, "cache"), join(root, "builds"), expected, signal()),
    ).rejects.toThrow("checksum mismatch before extraction");
    expect(readdirSync(join(root, "builds"))).toEqual([]);
    expect(readdirSync(join(root, "cache"))).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.CURL_NATIVE_SOURCE_ARCHIVE;
    else process.env.CURL_NATIVE_SOURCE_ARCHIVE = previous;
  }
});

test("deadline stops the shell and its child, not just the parent", async () => {
  const root = scratch();
  const pids = join(root, "pids");
  await expect(
    command(
      "/bin/sh",
      ["-c", 'echo $$ > "$1"; sleep 60 & echo $! >> "$1"; wait', "oracle-control", pids],
      root,
      signal(),
      100,
    ),
  ).rejects.toThrow("deadline");
  const observed = readFileSync(pids, "utf8").trim().split("\n");
  expect(observed).toHaveLength(2);
  for (const pid of observed) {
    const path = `/proc/${pid}/stat`;
    const state = processState(path);
    expect(state === undefined || state === "Z").toBe(true);
  }
});

test("pre-aborted and actively aborted native commands stop", async () => {
  const root = scratch();
  const marker = join(root, "executed");
  expect(() => command("/usr/bin/touch", [marker], root, AbortSignal.abort())).toThrow();
  expect(existsSync(marker)).toBe(false);
  await expect(command("/usr/bin/sleep", ["60"], root, AbortSignal.timeout(30))).rejects.toThrow(
    "aborted",
  );
});
