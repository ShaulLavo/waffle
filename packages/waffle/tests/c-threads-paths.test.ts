import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cThreadSafariRunner } from "./c-threads-packet.js";

const packageRoot = resolve(import.meta.dir, "..");
const omitted = new Set(["node_modules", "dist", "target"]);
const locations = ["plain", "space root", "literal%20root", "café日本語"];
let scratch = "";

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "waffle-c-thread-paths-"));
  for (const location of locations) {
    const root = join(scratch, location);
    cpSync(packageRoot, root, { recursive: true, filter: (path) => !omitted.has(basename(path)) });
    symlinkSync(join(packageRoot, "node_modules"), join(root, "node_modules"), "dir");
  }
});

for (const location of locations) {
  test(`C-thread subprocess tests discover from ${location}`, async () => {
    const root = join(scratch, location);
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "./tests/c-threads-runtime.test.ts",
        "./tests/c-threads-fixture.test.ts",
      ],
      {
        cwd: root,
        env: { ...process.env, C_THREAD_FIXTURE_DIR: "", C_THREADS_FIXTURE_PRODUCER_TESTS: "0" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const [output, errors] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(await child.exited, output.concat(errors)).toBe(0);
      expect(errors).toContain("9 pass");
      expect(errors).toContain("3 skip");
      expect(errors).toContain("0 fail");
    } finally {
      child.kill();
      await child.exited;
    }
  }, 30_000);

  test(`C-thread browser and Safari packet inputs bundle from ${location}`, async () => {
    const packet: typeof import("./c-threads-packet.js") = await import(
      pathToFileURL(join(scratch, location, "tests/c-threads-packet.ts")).href
    );
    expect(Object.keys(packet.cThreadBrowserSources)).toEqual([
      "c-positive.js",
      "runtime-page.js",
      "fs-worker.js",
      "preview1-worker.js",
      "thread-service.js",
      "thread-guest.js",
    ]);
    for (const source of Object.values(packet.cThreadBrowserSources)) {
      const result = await Bun.build({ entrypoints: [source], target: "browser" });
      expect(result.success, result.logs.map(String).join("\n")).toBe(true);
      expect(result.outputs).toHaveLength(1);
      expect(result.outputs[0]!.size).toBeGreaterThan(0);
    }
    expect(packet.cThreadSafariRunner).toBe(
      join(scratch, location, relative(packageRoot, cThreadSafariRunner)),
    );
    const safari = await Bun.build({ entrypoints: [packet.cThreadSafariRunner], target: "bun" });
    expect(safari.success, safari.logs.map(String).join("\n")).toBe(true);
    expect(safari.outputs).toHaveLength(1);
    expect(safari.outputs[0]!.size).toBeGreaterThan(0);
  }, 30_000);
}
