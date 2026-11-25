import { describe, expect, test } from "bun:test";
import { drainAsyncFileDiagnostic } from "../browser/diagnostic.js";
import { DescriptorTable } from "../core/descriptors.js";
import { claimFileOffset, shareFileResource } from "../core/open-file.js";
import { FilesystemClient, FilesystemCompletion } from "../fs/client.js";
import { PAGE } from "../fs/protocol.js";
import { CommandStdio } from "../proc/command-stdio.js";
import { openVfsBackend, VFS_BACKEND_KINDS, type VfsBackendKind } from "./fixtures/vfs-backends.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function runInWorker<T>(
  payload: Record<string, unknown> & {
    connection: ReturnType<Awaited<ReturnType<typeof openVfsBackend>>["forkConnection"]>;
  },
): Promise<T> {
  const worker = new Worker(
    new URL("./fixtures/vfs-fd-conformance-worker.ts", import.meta.url).href,
  );
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`vfs-fd-conformance worker timed out (${String(payload.scenario)})`));
    }, 15_000);
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message || "worker error"));
    };
    worker.onmessage = ({ data }: MessageEvent<{ value?: T; error?: string }>) => {
      clearTimeout(timer);
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data.value as T);
    };
    worker.postMessage(payload, [payload.connection.port]);
  });
}

async function waitReady(
  client: FilesystemClient,
  handle: number,
  writing: boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = client.ioReadiness(handle, writing);
    if (writing ? status.writable : status.readable) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`filesystem handle ${handle} never became ready (writing=${writing})`);
}

async function completeTryRead(
  client: FilesystemClient,
  handle: number,
  chunks: readonly Uint8Array[],
  offset: number,
): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = client.tryRead(handle, chunks, offset);
    if (result !== -6) return result;
    await waitReady(client, handle, false);
  }
  throw new Error("tryRead never completed");
}

async function completeTryWrite(
  client: FilesystemClient,
  handle: number,
  chunks: readonly Uint8Array[],
  offset: number,
): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = client.tryWrite(handle, chunks, offset);
    if (result !== -6) return result;
    await waitReady(client, handle, true);
  }
  throw new Error("tryWrite never completed");
}

async function completeTryAppend(
  client: FilesystemClient,
  handle: number,
  chunks: readonly Uint8Array[],
): Promise<{ written: number; offset: number } | number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = client.tryAppend(handle, chunks);
    if (result !== -6) return result;
    await waitReady(client, handle, true);
  }
  throw new Error("tryAppend never completed");
}

describe.each(VFS_BACKEND_KINDS)("VFS/FD conformance (%s)", (kind: VfsBackendKind) => {
  test("WASI regular-file FD contract (open/read/empty-iovec/write/pread/pwrite/seek/allocate/times/links/unlink-open/large)", async () => {
    const env = await openVfsBackend(kind);
    try {
      const result = await runInWorker<{ ok: boolean; largeSize: number; entries: string[] }>({
        scenario: "wasi-fd",
        connection: env.forkConnection(),
      });
      expect(result.ok).toBe(true);
      expect(result.largeSize).toBe(PAGE * 2 + 1234);
      expect(result.entries).toEqual([".", "..", "large.bin", "sym.txt"]);
    } finally {
      await env.close();
    }
  });

  test("cooperative runtime_proc redirection (echo >, >>, cat, independent opens, dup 2>&1, >128KiB stream, unlinked reopen, errors)", async () => {
    const env = await openVfsBackend(kind);
    try {
      const result = await runInWorker<{
        ok: boolean;
        outText: string;
        bigSize: number;
        waitsOnProcessWake: number;
      }>({
        scenario: "proc-redirection",
        connection: env.forkConnection(),
      });
      expect(result.ok).toBe(true);
      expect(result.outText).toBe("first\nsecond\n");
      expect(result.bigSize).toBe(PAGE * 2 + 9999);
      expect(result.waitsOnProcessWake).toBe(0);
    } finally {
      await env.close();
    }
  });

  test("concurrent writes through one shared inherited regular-file descriptor never lose data", async () => {
    const env = await openVfsBackend(kind);
    try {
      await env.client.asyncCall("writeFile", ["/shared.txt", false, false], new Uint8Array());
      const root: number = await env.client.asyncCall("preopen", ["/"]);
      const resolved = await env.client.asyncCall("resolve", [root, "shared.txt", true]);
      const handle = resolved.node as number;
      env.client.retain(handle);
      try {
        const resource = { kind: "file" as const, handle, offset: 0, append: false };
        const sharedOffset = shareFileResource(resource, env.client.connection);
        const barrier = new SharedArrayBuffer(4);
        const [a, b] = await Promise.all([
          runInWorker<{ ok: boolean; writtenTotal: number }>({
            scenario: "shared-write",
            connection: env.forkConnection("primary", [handle]),
            sharedHandle: handle,
            sharedOffset,
            barrier,
            byteValue: 65, // 'A'
          }),
          runInWorker<{ ok: boolean; writtenTotal: number }>({
            scenario: "shared-write",
            connection: env.forkConnection("primary", [handle]),
            sharedHandle: handle,
            sharedOffset,
            barrier,
            byteValue: 66, // 'B'
          }),
        ]);
        expect(a).toEqual({ ok: true, writtenTotal: 8 });
        expect(b).toEqual({ ok: true, writtenTotal: 8 });
        const content: Uint8Array = await env.client.asyncCall("readFile", ["/shared.txt"]);
        expect(content.length).toBe(16);
        const countA = Array.from(content).filter((byte) => byte === 65).length;
        const countB = Array.from(content).filter((byte) => byte === 66).length;
        expect(countA).toBe(8);
        expect(countB).toBe(8);
      } finally {
        env.client.release(handle);
      }
    } finally {
      await env.close();
    }
  });

  test("direct-memory try* honors nonblocking contract without Atomics.wait and directDisabled returns -58 without mutating", async () => {
    const env = await openVfsBackend(kind);
    const atomicsWait = Atomics.wait;
    const completionWait = FilesystemCompletion.prototype.wait;
    try {
      await env.client.asyncCall("writeFile", ["/nb.txt", false, false], encoder.encode("seed"));
      const root: number = await env.client.asyncCall("preopen", ["/"]);
      const resolved = await env.client.asyncCall("resolve", [root, "nb.txt", true]);
      const handle = resolved.node as number;
      env.client.retain(handle);

      Atomics.wait = (() => {
        throw new Error("Atomics.wait entered outside poll");
      }) as typeof Atomics.wait;
      FilesystemCompletion.prototype.wait = () => {
        throw new Error("completion.wait entered outside poll");
      };

      if (env.client.directDisabled) {
        expect(env.client.tryRead(handle, [new Uint8Array(8)], 0)).toBe(-58);
        expect(env.client.tryWrite(handle, [encoder.encode("X")], 0)).toBe(-58);
        expect(env.client.tryAppend(handle, [encoder.encode("Y")])).toBe(-58);
        // Zero side effects on unsupported try* calls.
        const unchanged: Uint8Array = await env.client.asyncCall("readFile", ["/nb.txt"]);
        expect(decoder.decode(unchanged)).toBe("seed");
      } else {
        const readBuf = new Uint8Array(16);
        expect(await completeTryRead(env.client, handle, [readBuf], 0)).toBe(4);
        expect(decoder.decode(readBuf.subarray(0, 4))).toBe("seed");
        expect(await completeTryWrite(env.client, handle, [encoder.encode("ABCD")], 0)).toBe(4);
        expect(await completeTryAppend(env.client, handle, [encoder.encode("EF")])).toEqual({
          written: 2,
          offset: 6,
        });
        const afterBuf = new Uint8Array(16);
        expect(await completeTryRead(env.client, handle, [afterBuf], 0)).toBe(6);
        expect(decoder.decode(afterBuf.subarray(0, 6))).toBe("ABCDEF");
        expect(env.client.tryRead(handle, [afterBuf], -1)).toBe(-28);
        expect(env.client.tryWrite(handle, [encoder.encode("x")], -1)).toBe(-28);
        expect(env.client.tryRead(handle, [afterBuf], Number.NaN)).toBe(-28);
        expect(env.client.tryWrite(handle, [encoder.encode("x")], Number.POSITIVE_INFINITY)).toBe(
          -28,
        );
      }

      env.client.release(handle);
      expect(env.client.completions.size).toBe(0);
    } finally {
      Atomics.wait = atomicsWait;
      FilesystemCompletion.prototype.wait = completionWait;
      await env.close();
    }
  });

  test("worker error diagnostic and CommandStdio work on redirected regular-file FDs", async () => {
    const env = await openVfsBackend(kind);
    try {
      const diag = await runInWorker<{ ok: boolean; postedCount: number }>({
        scenario: "diagnostic",
        connection: env.forkConnection(),
      });
      expect(diag.ok).toBe(true);
      const stderrBytes: Uint8Array = await env.client.asyncCall("readFile", ["/stderr.log"]);
      expect(decoder.decode(stderrBytes)).toContain("boom-from-worker");

      await env.client.asyncCall(
        "writeFile",
        ["/stdio.txt", false, false],
        encoder.encode("in-data"),
      );
      const descriptors = new DescriptorTable();
      const root: number = await env.client.asyncCall("preopen", ["/"]);
      const resolved = await env.client.asyncCall("resolve", [root, "stdio.txt", true]);
      const handle = resolved.node as number;
      env.client.retain(handle);
      try {
        const stdioConn = env.forkConnection("primary", [handle]);
        const controller = new AbortController();
        descriptors.open({ kind: "file", handle, offset: 0, append: false }, (1n << 29n) - 1n, 0n);
        descriptors.open({ kind: "file", handle, offset: 0, append: true }, (1n << 29n) - 1n, 0n);
        const stdio = new CommandStdio(descriptors, controller.signal, stdioConn);
        try {
          const readChunk = await stdio.stdin.read();
          expect(decoder.decode(readChunk!)).toBe("in-data");
          await stdio.stdout.write(encoder.encode("+out"));
        } finally {
          await stdio.settle();
        }
        const finalBytes: Uint8Array = await env.client.asyncCall("readFile", ["/stdio.txt"]);
        expect(decoder.decode(finalBytes)).toBe("in-data+out");
      } finally {
        descriptors.dispose();
        env.client.release(handle);
      }
    } finally {
      await env.close();
    }
  });
});

describe("MultiTabBackend cross-tab live freshness, failover, and diagnostic safety", () => {
  function runLiveWorker(
    connection: ReturnType<Awaited<ReturnType<typeof openVfsBackend>>["forkConnection"]>,
    gate: SharedArrayBuffer,
    checkFailoverWrite: boolean,
    onReady1: (text: string) => Promise<void>,
  ): Promise<{ ok: boolean; first: string; second: string; failoverWritten: boolean }> {
    const worker = new Worker(
      new URL("./fixtures/vfs-fd-conformance-worker.ts", import.meta.url).href,
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("live-descriptor worker timed out"));
      }, 15_000);
      worker.onerror = (event) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(event.message || "worker error"));
      };
      worker.onmessage = ({
        data,
      }: MessageEvent<{
        step?: string;
        text?: string;
        value?: { ok: boolean; first: string; second: string; failoverWritten: boolean };
        error?: string;
      }>) => {
        if (data.step === "ready1") {
          void onReady1(data.text!).then(
            () => {
              const cells = new Int32Array(gate);
              Atomics.store(cells, 0, 1);
              Atomics.notify(cells, 0);
            },
            (err) => {
              clearTimeout(timer);
              worker.terminate();
              reject(err);
            },
          );
          return;
        }
        clearTimeout(timer);
        worker.terminate();
        if (data.error) reject(new Error(data.error));
        else resolve(data.value!);
      };
      worker.postMessage({ scenario: "live-descriptor", connection, gate, checkFailoverWrite }, [
        connection.port,
      ]);
    });
  }

  test("a surviving Peer open descriptor observes a cross-tab Host overwrite freshly without reopening", async () => {
    const env = await openVfsBackend("multitab-peer");
    try {
      await env.peerClient!.asyncCall(
        "writeFile",
        ["/cross-tab.txt", false, false],
        encoder.encode("v1-from-host"),
      );
      const gate = new SharedArrayBuffer(4);
      const result = await runLiveWorker(env.forkConnection("primary"), gate, false, async () => {
        await env.peerClient!.asyncCall(
          "writeFile",
          ["/cross-tab.txt", false, false],
          encoder.encode("v2-overwritten"),
        );
      });
      expect(result.ok).toBe(true);
      expect(result.first).toBe("v1-from-host");
      expect(result.second).toBe("v2-overwritten");
    } finally {
      await env.close();
    }
  });

  test("a surviving Peer worker and open descriptor stay intact across graceful Host-close failover", async () => {
    const env = await openVfsBackend("multitab-peer");
    try {
      await env.peerClient!.asyncCall(
        "writeFile",
        ["/cross-tab.txt", false, false],
        encoder.encode("before-failover"),
      );
      const gate = new SharedArrayBuffer(4);
      const result = await runLiveWorker(env.forkConnection("primary"), gate, true, async () => {
        await env.closeCounterpart!();
      });
      expect(result.ok).toBe(true);
      expect(result.first).toBe("before-failover");
      expect(result.second).toBe("before-failover");
      expect(result.failoverWritten).toBe(true);
      const persisted: Uint8Array = await env.client.asyncCall("readFile", ["/after-failover.txt"]);
      expect(decoder.decode(persisted)).toBe("survived-failover");
    } finally {
      await env.close();
    }
  });

  test("drainAsyncFileDiagnostic holds shared offset until a timed-out write authoritatively settles and resists poisoned globals", async () => {
    const env = await openVfsBackend("multitab-peer");
    try {
      await env.client.asyncCall("writeFile", ["/diag.txt", false, false], encoder.encode("seed"));
      const root: number = await env.client.asyncCall("preopen", ["/"]);
      const resolved = await env.client.asyncCall("resolve", [root, "diag.txt", true]);
      const handle = resolved.node as number;
      env.client.retain(handle);
      try {
        const resource = { kind: "file" as const, handle, offset: 0, append: false };
        const sharedOffset = shareFileResource(resource, env.client.connection);

        // 1. Pause the Peer->Host write after dispatch and force a short stall timeout.
        let releaseWrite!: () => void;
        const writePaused = Promise.withResolvers<void>();
        const origExecute = env.backend.execute.bind(env.backend);
        let pauseOnce = true;
        env.backend.execute = (op: string, args: unknown[], data: Uint8Array) => {
          if (op === "write" && pauseOnce) {
            pauseOnce = false;
            const gate = Promise.withResolvers<void>();
            releaseWrite = () => gate.resolve();
            writePaused.resolve();
            return gate.promise.then(() => origExecute(op, args, data));
          }
          return origExecute(op, args, data);
        };

        let timeoutError: unknown;
        try {
          await drainAsyncFileDiagnostic(
            env.client,
            resource,
            encoder.encode("DIAG"),
            () => true,
            40,
          );
        } catch (error) {
          timeoutError = error;
        }
        expect(timeoutError).toBeInstanceOf(Error);
        expect(String(timeoutError)).toContain("diagnostic reader made no progress");
        await writePaused.promise;

        // While the dispatched write is still paused, another holder MUST see busy (offset 0 locked).
        expect(claimFileOffset(resource).kind).toBe("busy");

        // Resume backend write -> authoritative settlement commits offset 4 and unlocks!
        releaseWrite();
        await new Promise((resolve) => setTimeout(resolve, 30));
        const afterResume = claimFileOffset(resource);
        expect(afterResume.kind).toBe("acquired");
        if (afterResume.kind === "acquired") {
          expect(afterResume.lease.position).toBe(4);
          afterResume.lease.release();
        }
        expect(decoder.decode(await env.client.asyncCall("readFile", ["/diag.txt"]))).toBe("DIAG");

        // 2. In a separate Worker realm, poisoned Math.min, Number.isInteger, and Promise.prototype.then
        // never break drainAsyncFileDiagnostic or strand the shared offset lease.
        const poisoned = await runInWorker<{ ok: boolean; thenTouched: number; position: number }>({
          scenario: "poisoned-diagnostic",
          connection: env.forkConnection("primary", [handle]),
          sharedHandle: handle,
          sharedOffset,
        });
        expect(poisoned).toEqual({ ok: true, thenTouched: 0, position: 5 });
        expect(decoder.decode(await env.client.asyncCall("readFile", ["/diag.txt"]))).toBe("DIAG!");

        // 3. A synchronous submit failure after lease acquisition still releases the lease.
        const origSubmit = env.client.submit.bind(env.client);
        env.client.submit = () => {
          throw new Error("submit boom");
        };
        try {
          await expect(
            drainAsyncFileDiagnostic(env.client, resource, encoder.encode("Z"), () => true),
          ).rejects.toThrow("diagnostic write failed");
        } finally {
          env.client.submit = origSubmit;
        }
        const afterFailure = claimFileOffset(resource);
        expect(afterFailure.kind).toBe("acquired");
        if (afterFailure.kind === "acquired") afterFailure.lease.release();
      } finally {
        env.client.release(handle);
      }
    } finally {
      await env.close();
    }
  });
});
