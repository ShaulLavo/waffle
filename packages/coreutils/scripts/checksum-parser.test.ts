import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { checksumSource, prepareChecksumSource } from "./prepare-checksum-source.ts";

function between(source: string, start: string, end: string) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}

test("the actual patched upstream record parsers decode escaped filenames once", () => {
  prepareChecksumSource();
  const checksum = resolve(checksumSource, "src/uucore/src/lib/features/checksum");
  const validate = readFileSync(resolve(checksum, "validate.rs"), "utf8");
  const algorithms = readFileSync(resolve(checksum, "mod.rs"), "utf8");
  const parsers = between(
    validate,
    "#[derive(Debug, PartialEq, Eq, Clone, Copy)]\nenum LineFormat",
    "/// Extract the expected digest",
  );
  const unescape = between(algorithms, "pub fn unescape_filename", "pub fn escape_filename");
  const parent = resolve(import.meta.dirname, "../../../.build");
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(resolve(parent, "checksum-parser-"));
  try {
    const tests = resolve(checksum, "record_tests.rs");
    const prelude =
      "use std::ffi::OsStr;\nuse std::os::unix::ffi::OsStrExt;\nfn os_str_as_bytes(s: &OsStr) -> Result<&[u8], ()> { Ok(s.as_bytes()) }\n";
    const source =
      prelude + unescape + parsers + `\n#[path = ${JSON.stringify(tests)}]\nmod record_tests;\n`;
    const input = resolve(temporary, "records.rs");
    const executable = resolve(temporary, "records");
    writeFileSync(input, source);
    execFileSync("rustc", ["--edition=2024", "--test", input, "-o", executable], {
      stdio: "inherit",
      timeout: 30_000,
    });
    execFileSync(executable, ["--nocapture"], { stdio: "inherit", timeout: 10_000 });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
