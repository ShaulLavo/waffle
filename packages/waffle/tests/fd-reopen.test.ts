import { describe, test } from "bun:test";
import { fdReopenCases } from "./fixtures/fd-reopen-cases.js";
import { openVfsBackend, VFS_BACKEND_KINDS, type VfsBackendKind } from "./fixtures/vfs-backends.js";

const cases = fdReopenCases();

for (const { label, run } of cases) test(label, () => run());

function runCaseInWorker(
  connection: ReturnType<Awaited<ReturnType<typeof openVfsBackend>>["forkConnection"]>,
  index: number,
): Promise<void> {
  const worker = new Worker(new URL("./fixtures/fd-reopen-worker.ts", import.meta.url).href);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`fd-reopen worker timed out for case ${index}`));
    }, 15_000);
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message || "fd-reopen worker error"));
    };
    worker.onmessage = ({ data }: MessageEvent<{ ok?: boolean; error?: string }>) => {
      clearTimeout(timer);
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve();
    };
    worker.postMessage({ connection, index }, [connection.port]);
  });
}

// Representative subset + full traversal/redirect matrix across every VFS backend
// (memory, single-tab persistent, MultiTabBackend host, and MultiTabBackend peer).
const BACKEND_CASE_PATTERNS = [
  "regular files start at zero",
  "write-only source can reopen",
  "TRUNC resets the inode",
  "APPEND and NONBLOCK flags",
  "unlinked open inode survives",
  "inode read and write denial",
  "the live root capability bounds",
  "pipe endpoints stay shared",
  "terminal and directory duplicates",
  "closed descriptors return EBADF",
  "invalid creation flags",
  "direct WASI reopen keeps EBADF",
  "direct and alias output spans",
  "inode open failures keep positive errno",
  "ordinary opens and descriptor reopens",
  "only root directory bindings",
  "descriptor aliases enforce root search",
  "path_open /dev/fd/N resolves",
  "path_open /dev/stdout follows",
  "stdout source plain, redirect > exact Linux bytes",
  "stdout source plain, redirect >> exact Linux bytes",
  "stdout source APPEND, redirect > exact Linux bytes",
  "stdout source APPEND, redirect >> exact Linux bytes",
  "stderr source APPEND, redirect >> exact Linux bytes",
  "child inherited fd 3 reopens independently",
];

const selectedIndices = cases
  .map((entry, index) => ({ label: entry.label, index }))
  .filter(({ label }) => BACKEND_CASE_PATTERNS.some((pattern) => label.includes(pattern)));

describe.each(VFS_BACKEND_KINDS)("fd_reopen worker conformance (%s)", (kind: VfsBackendKind) => {
  test(`passes all ${selectedIndices.length} fd_reopen and /dev/fd/N redirect cases`, async () => {
    for (const { label, index } of selectedIndices) {
      const env = await openVfsBackend(kind);
      try {
        await runCaseInWorker(env.forkConnection(), index);
      } catch (error) {
        throw new Error(
          `[${kind}] ${label}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await env.close();
      }
    }
  });
});
