import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { packageRoot, sourceLock } from "./build-config.ts";

export function generateDiffutilsNotices() {
  const license = readFileSync(resolve(packageRoot, "LICENSE.gnu"), "utf8");
  const notice = [
    "GNU diffutils 3.12",
    "Copyright (C) 1988-2025 Free Software Foundation, Inc.",
    "License: GPL-3.0-or-later",
    `Source: ${sourceLock.upstream.archive}`,
    `SHA-256: ${sourceLock.upstream.archiveSha256}`,
    "Local WASI adaptations are recorded in patches/gnu-wasi.patch.",
    "",
    license,
  ].join("\n");
  mkdirSync(resolve(packageRoot, "dist"), { recursive: true });
  writeFileSync(resolve(packageRoot, "dist/THIRD_PARTY_NOTICES.txt"), notice);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  generateDiffutilsNotices();
}
