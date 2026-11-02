import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { packageRoot } from "./build-config.ts";
import { sourceLock } from "./source-lock.ts";

export function generateNotices(): void {
  const license = readFileSync(resolve(packageRoot, "LICENSE"), "utf8");
  const metadata: unknown = JSON.parse(
    readFileSync(resolve(packageRoot, "licenses/wasi-libc.json"), "utf8"),
  );
  assert.ok(
    metadata &&
      typeof metadata === "object" &&
      "files" in metadata &&
      metadata.files &&
      typeof metadata.files === "object",
  );
  const included = Object.entries(metadata.files).map(([name, value]: [string, unknown]) => {
    assert.ok(value && typeof value === "object" && "sha256" in value);
    const bytes = readFileSync(resolve(packageRoot, "licenses", name));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), value.sha256, name);
    return `## wasi-libc / ${name}\n\n${bytes.toString()}\n`;
  });
  const notices = [
    `# Third-party notices\n\n## The One True Awk\n\nSource revision: ${sourceLock.upstream.revision}\n\n${license}\n`,
  ]
    .concat(included)
    .join("\n");
  mkdirSync(resolve(packageRoot, "dist"), { recursive: true });
  writeFileSync(resolve(packageRoot, "dist/THIRD_PARTY_NOTICES.txt"), notices);
}
