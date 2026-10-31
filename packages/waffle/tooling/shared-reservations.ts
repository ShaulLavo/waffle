import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Explicit trusted construction boundaries. Runtime paths must provide their allocation hooks. */
const boundaries: Readonly<Record<string, string>> = {
  "memory/reservations.ts": "Page-wide charge-before-construction authority.",
  "memory/allocator.ts":
    "Import-inert realm router; live runtimes install their captured, charged allocator. The lazy native fallback is only for standalone core embeddings.",
  "memory/control.ts":
    "Captured guest control allocator claims a finite grant before construction.",
  "memory/probe-worker.ts":
    "Disposable measurement worker, terminated before runtime construction.",
  "proc/intrinsics/host.ts":
    "Captured native primitive; runtime callers must supply an allocation authority.",
  "proc/pipes.ts":
    "Pipe registry and private PipeState allocation hooks supplied by the owning realm.",
  "fs/request-memory.ts":
    "Runtime pools receive ArenaSource; standalone transport and ResidentConstruction tests retain explicit allocators.",
  "fs/protocol.ts":
    "Runtime roots receive FilesystemOwnerConstruction; createSharedSegment is a standalone low-level embedding boundary.",
  "fs/shared.ts":
    "Dedicated service attaches the page-owned root; standalone backends can construct their own storage.",
  "fs/publication.ts":
    "Runtime publication receives an exact allocator; standalone/resident tests retain their own authority.",
  "group/state.ts":
    "Runtime groups use GroupMemorySource; standalone low-level tests retain the growable-memory constructor.",
  "fs/memory-budget.ts":
    "Separate resident-byte allocator used by explicit local-memory experiments and standalone tests.",
};
const roots = ["memory", "core", "fs", "proc", "browser", "group", "link", "interrupt"];
const nativeConstruction =
  /\bnew\s+(?:SharedArrayBuffer|SharedArrayBufferConstructor|NativeSharedArrayBuffer|WebAssembly\.Memory)\s*\(|\bcreateGrowableSharedArrayBuffer\s*\(|\bReflect\.construct\s*\(\s*SharedArrayBuffer/;
export function unaccountedSharedConstruction(path: string, source: string): boolean {
  return !boundaries[path] && nativeConstruction.test(source);
}
export function sharedReservationFindings(root: string): string[] {
  const findings: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const key = relative(root, path).replaceAll("\\", "/");
      if (unaccountedSharedConstruction(key, readFileSync(path, "utf8"))) findings.push(key);
    }
  }
  for (const directory of roots) visit(join(root, directory));
  return findings;
}
if (import.meta.main) {
  const findings = sharedReservationFindings(join(import.meta.dir, ".."));
  if (findings.length)
    throw new Error(
      `Shared backing construction needs an allocation authority: ${findings.join(", ")}`,
    );
}
