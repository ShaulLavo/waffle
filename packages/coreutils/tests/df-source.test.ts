import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { dfCases } from "../fixtures/df-cases.ts";
import { compareDf } from "../scripts/df-oracle.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const revision = "07763857f6b9a547742a994b58aef0ccd036198b";

test("df is an isolated pinned upstream entry without a replacement evaluator", () => {
  const manifest = read("../crates/df/Cargo.toml");
  assert.match(manifest, /\[workspace\]/);
  assert.equal(manifest.match(new RegExp(`rev = "${revision}"`, "g"))?.length, 2);
  assert.equal(read("../crates/df/src/main.rs").trim().split("\n").at(-1), "uucore::bin!(uu_df);");
  assert.match(read("../crates/df/Cargo.lock"), new RegExp(`name = "uu_df"[\\s\\S]*?${revision}`));
});

test("df oracle fixtures never request host-wide or capacity output", () => {
  for (const fixture of dfCases) {
    if (fixture.metadata) continue;
    assert.ok(
      fixture.args.some((arg) =>
        ["input", "directory", "file with spaces", "link", "missing", "broken"].includes(arg),
      ),
    );
    assert.equal(
      fixture.args.some((arg) =>
        ["--all", "-a", "--sync", "--output", "--output=size", "--output=target"].includes(arg),
      ),
      false,
    );
  }
});

test("df rejects an unpinned oracle before creating fixtures or executing a candidate", () => {
  assert.throws(
    () => compareDf("/not-executed", "/not-created", "/usr/bin/true"),
    /Unpinned GNU df oracle/,
  );
});
