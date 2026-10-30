import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sources from "./sources.json" with { type: "json" };

export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sourceIdentity(version: string) {
  if (version === "0.12.0") return sources["0.12.0"];
  if (version === "0.13.0") return sources["0.13.0"];
  throw new Error(`Unsupported uucore version: ${version}`);
}

export function patchBuildScript(
  source: string,
  version: string,
  generator: string,
  wrapper: string,
) {
  assert.equal(
    sha256(source),
    sourceIdentity(version).buildScriptSha256,
    "Unpinned uucore build.rs",
  );
  const declaration = "pub fn main() -> Result<(), Box<dyn std::error::Error>> {";
  assert.equal(source.split(declaration).length, 2, "Expected exactly one upstream build entry");
  const module =
    `mod waffle_locales {\ninclude!(${JSON.stringify(generator)});\n` +
    `pub fn generate() -> Result<(), Box<dyn std::error::Error>> { main() }\n}\n` +
    `const _: &str = env!("WAFFLE_PROGRAM_LOCALE_IMPLEMENTATION");\n` +
    `const _: &[u8] = include_bytes!(${JSON.stringify(wrapper)});\n`;
  const entry = source.indexOf('    let out_dir = env::var("OUT_DIR")?;');
  assert.ok(entry > source.indexOf(declaration), "Missing pinned generator entry");
  return source.slice(0, entry) + "    waffle_locales::generate()\n}\n" + module;
}
