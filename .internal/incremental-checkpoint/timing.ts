import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkpointRun } from "./lease-hooks.js";

const [source, arm] = process.argv.slice(2);
if (!source || !arm) throw new Error("Expected disposable source and arm");

async function replace(name: string, before: string, after: string) {
  const path = resolve(source!, name);
  const text = await readFile(path, "utf8");
  if (!text.includes(before)) throw new Error(`Missing timing anchor: ${name}: ${before}`);
  await writeFile(path, text.replace(before, after));
}

await replace(
  "tooling/vfs-benchmark.ts",
  "  if (process.env.WAFFLE_CHECKPOINT_PROBE_BASE === revision) return revision;",
  "  const archived = process.env.WAFFLE_CHECKPOINT_PROBE_BASE;\n  if (archived && /^[a-f0-9]{40}$/.test(archived)) return archived;",
);

const browserPath = resolve(source, "tooling/vfs-browser.ts");
const browser = await readFile(browserPath, "utf8");
const start = browser.indexOf("async function checkpointRun(");
const end = browser.indexOf("async function verifyCheckpoint(", start);
if (start < 0 || end < 0) throw new Error("Missing checkpoint fixture");
await writeFile(browserPath, browser.slice(0, start) + checkpointRun + browser.slice(end));
await replace(
  "tooling/vfs-browser.ts",
  "import { SharedFilesystem }",
  'import { FilesystemClient } from "../fs/client.js";\nimport { SharedFilesystem }',
);
await replace(
  "tooling/vfs-browser.ts",
  '  whenBusy?: "wait";',
  '  whenBusy?: "wait";\n  leased?: boolean;',
);
await replace(
  "tooling/vfs-browser.ts",
  "      name: input.name,",
  "      name: input.name,\n      workspace: input.leased === true,",
);
await replace(
  "tooling/vfs-browser.ts",
  "checkpointRun(measured, facade, input.lane)",
  "checkpointRun(measured, facade, input.lane, input.leased === true)",
);
await replace(
  "tooling/vfs-benchmark.ts",
  '    name: workload === "W6" ?',
  '    leased: process.env.WAFFLE_CHECKPOINT_LEASE === "1",\n    name: workload === "W6" ?',
);
await replace(
  "tooling/vfs-benchmark.ts",
  '  const verified = await worker(page, { ...run.input, action: "checkpoint-verify" });',
  '  const start = performance.now();\n  const verified = await worker(page, { ...run.input, action: "checkpoint-verify" });\n  run.sample.metrics.reopenVerifyMs = performance.now() - start;',
);

if (arm === "control") {
  await replace(
    "fs/shared.ts",
    "      const data = new Uint8Array(stat.size);",
    "      const copyStart = performance.now();\n      const data = new Uint8Array(stat.size);",
  );
  await replace(
    "fs/shared.ts",
    "probeCapture(data, this);",
    "probeCapture(data, this, performance.now() - copyStart);",
  );
  await replace(
    "fs/storage.ts",
    "      const copy = new Uint8Array(bytes);",
    "      const start = performance.now();\n      const copy = new Uint8Array(bytes);",
  );
  await replace(
    "fs/storage.ts",
    "probeBatch(bytes, copy);",
    "probeBatch(bytes, copy, performance.now() - start);",
  );
  await replace(
    "fs/indexeddb-chunks.ts",
    "  const chunks: ChunkRecord[] = [];",
    "  const chunks: ChunkRecord[] = [];\n  const prepStart = performance.now();\n  let copyMs = 0;\n  let hashMs = 0;",
  );
  await replace(
    "fs/indexeddb-chunks.ts",
    "    const part = bytes.slice(offset, offset + CHUNK_SIZE);\n    chunks.push({ bytes: part, checksum: await chunkChecksum(part) });",
    "    const sliceStart = performance.now();\n    const part = bytes.slice(offset, offset + CHUNK_SIZE);\n    const hashStart = performance.now();\n    copyMs += hashStart - sliceStart;\n    chunks.push({ bytes: part, checksum: await chunkChecksum(part) });\n    hashMs += performance.now() - hashStart;",
  );
  await replace(
    "fs/indexeddb-chunks.ts",
    "probePreparedChunks(bytes, chunks);",
    "probePreparedChunks(bytes, chunks, { copyMs, hashMs, totalMs: performance.now() - prepStart });",
  );
  await replace(
    "fs/checkpoint-probe.ts",
    "  snapshotBytes: number;",
    "  snapshotBytes: number;\n  snapshotMs: number;\n  batchMs?: number;\n  preparedMs?: { copyMs: number; hashMs: number; totalMs: number };",
  );
  await replace(
    "fs/checkpoint-probe.ts",
    "shared: SharedFilesystemState): void",
    "shared: SharedFilesystemState, snapshotMs: number): void",
  );
  await replace(
    "fs/checkpoint-probe.ts",
    "    snapshotBytes: data.byteLength,",
    "    snapshotBytes: data.byteLength,\n    snapshotMs,",
  );
  await replace(
    "fs/checkpoint-probe.ts",
    "copy: Uint8Array): void",
    "copy: Uint8Array, batchMs: number): void",
  );
  await replace(
    "fs/checkpoint-probe.ts",
    "  capture.batchBytes = copy.byteLength;",
    "  capture.batchBytes = copy.byteLength;\n  capture.batchMs = batchMs;",
  );
  await replace(
    "fs/checkpoint-probe.ts",
    "chunks: readonly { bytes: Uint8Array }[]): void",
    'chunks: readonly { bytes: Uint8Array }[], preparedMs: Capture["preparedMs"]): void',
  );
  await replace(
    "fs/checkpoint-probe.ts",
    "  capture.slices = chunks.length;",
    "  capture.slices = chunks.length;\n  capture.preparedMs = preparedMs;",
  );
  await replace(
    "fs/checkpoint-probe.ts",
    '  tx.addEventListener("complete", () => {',
    '  const submitted = performance.now();\n  tx.addEventListener("complete", () => {',
  );
  await replace(
    "fs/checkpoint-probe.ts",
    "durability: tx.durability",
    "durability: tx.durability, putToCompleteMs: performance.now() - submitted",
  );
}
