import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fixture from "../fixtures/head-gnu.json" with { type: "json" };

const replayPath = new URL("test-own-shell-head.ts", import.meta.url);

test("head qualification replays observations without host subprocesses", () => {
  const source = readFileSync(replayPath, "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFileSync/);
  assert.match(source, /fixtures\/head-gnu\.json/);
});

test("head observations retain the approved Bash and identified GNU tool recordings", () => {
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  assert.equal(fixture.schema, 1);
  assert.equal(
    fixture.oracle.bash.version,
    "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)",
  );
  assert.equal(
    fixture.oracle.bash.sha256,
    "575e03ac834b739349a4484de481abcd06a6f7193cefc795260a32a1943f20a5",
  );
  assert.equal(fixture.oracle.head.version, "head (GNU coreutils) 9.12");
  assert.equal(
    fixture.oracle.head.sha256,
    "313bf1f0c296d63fa9534394e22a502cfe29d9fe9e110c5b45f3c070b9ddf3e1",
  );
  assert.equal(fixture.cases.length, 24);
  const cases = fixture.cases.map((entry) => [entry.name, entry.script]);
  assert.equal(hash(JSON.stringify(cases)), fixture.casesSha256);
  assert.equal(
    fixture.casesSha256,
    "66256ffe42aad6bc4aa7485e397f57ddbe25ef01826e176800ce337f5bdbaecf",
  );
  assert.equal(
    hash(JSON.stringify(fixture)),
    "3ef95d7d25f72486e543a3b4944259efde0728731c33dfa4780fb97fd2acdf32",
  );
});
