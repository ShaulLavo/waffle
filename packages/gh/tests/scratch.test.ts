import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createScratch } from "./scratch.ts";

test("fixture scratch honors the caller's temporary directory", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gh-scratch-test-"));
  const previous = process.env.TMPDIR;
  let scratch: string | undefined;
  try {
    process.env.TMPDIR = parent;
    scratch = await createScratch("gh-probe-");
    assert.equal(dirname(scratch), parent);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    if (scratch) await rm(scratch, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});
