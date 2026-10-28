import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchGitSource } from "./patch-git-source.ts";

test("Git source patch is idempotent on the installed backend", async () => {
  const before = await digest();
  patchGitSource();
  assert.deepEqual(await digest(), before);
});

test("Git source patch rejects changed upstream bytes before mutation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "bash-web-git-source-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = `${root}/node_modules/isomorphic-git`;
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/package.json`, JSON.stringify({ version: "1.44.5" }));
  await writeFile(`${directory}/index.js`, "changed upstream source");
  assert.throws(() => patchGitSource(root), /unrecognized Git source/);
  assert.equal(await readFile(`${directory}/index.js`, "utf8"), "changed upstream source");
});

async function digest() {
  return Promise.all(
    ["index.js", "index.cjs", "managers/index.js", "managers/index.cjs", "models/index.js"].map(
      async (file) =>
        createHash("sha256")
          .update(await readFile(`node_modules/isomorphic-git/${file}`))
          .digest("hex"),
    ),
  );
}
