import { describe, test } from "bun:test";
import { fdReopenCases } from "./fixtures/fd-reopen-cases.js";
import { openVfsBackend, VFS_BACKEND_KINDS, type VfsBackendKind } from "./fixtures/vfs-backends.js";

const cases = fdReopenCases();

for (const { label, run } of cases) test(label, () => run());

function sendCaseToWorker(
  worker: Worker,
  connection: ReturnType<Awaited<ReturnType<typeof openVfsBackend>>["forkConnection"]>,
  index: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`fd-reopen worker timed out for case ${index}`));
    }, 15_000);
    worker.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(event.message || "fd-reopen worker error"));
    };
    worker.onmessage = ({ data }: MessageEvent<{ ok?: boolean; error?: string }>) => {
      clearTimeout(timer);
      if (data.error) reject(new Error(data.error));
      else resolve();
    };
    worker.postMessage({ connection, index }, [connection.port]);
  });
}

describe.each(VFS_BACKEND_KINDS)("fd_reopen full conformance (%s)", (kind: VfsBackendKind) => {
  test(`passes all ${cases.length} fd_reopen and /dev/fd/N redirect cases`, async () => {
    const worker = new Worker(new URL("./fixtures/fd-reopen-worker.ts", import.meta.url).href);
    try {
      for (let index = 0; index < cases.length; index++) {
        const entry = cases[index]!;
        const env = await openVfsBackend(kind);
        try {
          await sendCaseToWorker(worker, env.forkConnection(), index);
        } catch (error) {
          throw new Error(
            `[${kind}] ${entry.label}: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          await env.close();
        }
      }
    } finally {
      worker.terminate();
    }
  }, 60_000);
});
