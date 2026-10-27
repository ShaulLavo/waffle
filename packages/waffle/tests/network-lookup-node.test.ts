import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

test("native Bun embedders use lookup through prepared Node package exports", () => {
  const script = `
    import assert from "node:assert/strict";
    import { createRuntime, RuntimeNetworkLookupError } from "waffle";
    assert.match(import.meta.resolve("waffle"), /\\/dist\\/index\\.js$/);
    const runtime = createRuntime({
      filesystem: { mode: "memory", workerURL: new URL("./dist/browser/fs-worker.js", import.meta.url) },
      processHost() { throw Error("Lookup activated processes"); },
    });
    const network = await runtime.network();
    try {
      assert.deepEqual(network.lookup("localhost", { family: 0, hints: 0 }), [{ address: "127.0.0.1", family: 4 }]);
      assert.deepEqual(network.lookup("::1"), [{ address: "::1", family: 6 }]);
      assert.throws(() => network.lookup("example.com"), error => error instanceof RuntimeNetworkLookupError &&
        error.code === "ENOTSUP" && error.syscall === "getaddrinfo" && error.hostname === "example.com");
    } finally { await runtime.dispose(); }
    assert.throws(() => network.lookup("localhost"), /Runtime is disposed/);
    console.log("prepared Node lookup, numeric families, structured errors and disposal passed");
  `;
  expect(
    execFileSync(process.execPath, ["--eval", script], {
      cwd: resolve(import.meta.dir, ".."),
      encoding: "utf8",
      timeout: 10000,
    }),
  ).toContain("prepared Node lookup");
});
