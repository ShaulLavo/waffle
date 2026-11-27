import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = resolve(import.meta.dirname, "..");

interface SourceLockShape {
  readonly upstream: {
    readonly name: string;
    readonly version: string;
    readonly revision: string;
    readonly licensePath: string;
    readonly licenseSha256: string;
  };
}

function readLock(): SourceLockShape {
  const parsed: unknown = JSON.parse(
    readFileSync(resolve(packageRoot, "sources.lock.json"), "utf8"),
  );
  assert.ok(parsed && typeof parsed === "object" && "upstream" in parsed);
  const upstream = parsed.upstream;
  assert.ok(
    upstream &&
      typeof upstream === "object" &&
      "name" in upstream &&
      typeof upstream.name === "string" &&
      "version" in upstream &&
      typeof upstream.version === "string" &&
      "revision" in upstream &&
      typeof upstream.revision === "string" &&
      "licensePath" in upstream &&
      typeof upstream.licensePath === "string" &&
      "licenseSha256" in upstream &&
      typeof upstream.licenseSha256 === "string",
  );
  return { upstream };
}

export function generateNotices(): void {
  const lock = readLock();
  const licenseBytes = readFileSync(resolve(packageRoot, lock.upstream.licensePath));
  assert.equal(
    createHash("sha256").update(licenseBytes).digest("hex"),
    lock.upstream.licenseSha256,
    lock.upstream.licensePath,
  );
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
  const header = `# Third-party notices\n\n## ${lock.upstream.name} (${lock.upstream.version})\n\nSource revision: ${lock.upstream.revision}\n\n${licenseBytes.toString()}\n`;
  const notices = [header].concat(included).join("\n");
  mkdirSync(resolve(packageRoot, "dist"), { recursive: true });
  writeFileSync(resolve(packageRoot, "dist/THIRD_PARTY_NOTICES.txt"), notices);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  generateNotices();
}
