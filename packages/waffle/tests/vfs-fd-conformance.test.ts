import { describe, expect, test } from "bun:test";
import { DescriptorTable } from "../core/descriptors.js";
import { FilesystemClient, FilesystemCompletion } from "../fs/client.js";
import { PAGE } from "../fs/protocol.js";
import { CommandStdio } from "../proc/command-stdio.js";
import { openVfsBackend, VFS_BACKEND_KINDS, type VfsBackendKind } from "./fixtures/vfs-backends.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function runInWorker<T>(
  scenario: "wasi-fd" | "proc-redirection" | "poll-wake" | "diagnostic",
  connection: ReturnType<Awaited<ReturnType<typeof openVfsBackend>>["forkConnection"]>,
  seedText?: string,
): Promise<T> {
  const worker = new Worker(
    new URL("./fixtures/vfs-fd-conformance-worker.ts", import.meta.url).href,
  );
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`vfs-fd-conformance worker timed out (${scenario})`));
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
    worker.postMessage({ scenario, connection, seedText }, [connection.port]);
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
  test("WASI regular-file FD contract (open/read/write/pread/pwrite/seek/allocate/times/links/unlink-open/large)", async () => {
    const env = await openVfsBackend(kind);
    try {
      const result = await runInWorker<{ ok: boolean; largeSize: number; entries: string[] }>(
        "wasi-fd",
        env.forkConnection(),
      );
      expect(result.ok).toBe(true);
      expect(result.largeSize).toBe(PAGE * 2 + 1234);
      expect(result.entries).toEqual([".", "..", "large.bin", "sym.txt"]);
    } finally {
      await env.close();
    }
  });

  test("cooperative runtime_proc redirection (echo >, >>, cat, dup 2>&1, >128KiB stream, unlinked reopen, errors)", async () => {
    const env = await openVfsBackend(kind);
    try {
      const result = await runInWorker<{
        ok: boolean;
        outText: string;
        bigSize: number;
        waitsOnFsSignal: number;
        waitsOnProcessWake: number;
      }>("proc-redirection", env.forkConnection());
      expect(result.ok).toBe(true);
      expect(result.outText).toBe("first\nsecond\n");
      expect(result.bigSize).toBe(PAGE * 2 + 9999);
      // Whenever nonblocking file I/O parks in poll, it wakes on fs.signal, never stalling on processWake!
      expect(result.waitsOnProcessWake).toBe(0);
      if (kind === "multitab-host" || kind === "multitab-peer") {
        expect(result.waitsOnFsSignal).toBeGreaterThan(0);
      }
    } finally {
      await env.close();
    }
  });

  test("ProcessABI.poll waits directly on fs.signal for pending file I/O instead of silent process wake", async () => {
    const env = await openVfsBackend(kind);
    try {
      const result = await runInWorker<{
        ok: boolean;
        waitWords: string[];
        directDisabled: boolean;
      }>("poll-wake", env.forkConnection());
      expect(result.ok).toBe(true);
      expect(result.waitWords).not.toContain("process.wake");
      if (result.directDisabled) {
        expect(result.waitWords.every((word) => word === "fs.signal")).toBe(true);
      }
    } finally {
      await env.close();
    }
  });

  test("nonblocking tryRead/tryWrite/tryAppend/ioReadiness never enter completion.wait or Atomics.wait", async () => {
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

      const readBuf = new Uint8Array(16);
      expect(await completeTryRead(env.client, handle, [readBuf], 0)).toBe(4);
      expect(decoder.decode(readBuf.subarray(0, 4))).toBe("seed");

      // Write at offset 0 then append on the same handle (must not alias write vs append!)
      expect(await completeTryWrite(env.client, handle, [encoder.encode("ABCD")], 0)).toBe(4);
      expect(await completeTryAppend(env.client, handle, [encoder.encode("EF")])).toEqual({
        written: 2,
        offset: 6,
      });

      const afterBuf = new Uint8Array(16);
      expect(await completeTryRead(env.client, handle, [afterBuf], 0)).toBe(6);
      expect(decoder.decode(afterBuf.subarray(0, 6))).toBe("ABCDEF");

      // Negative and non-safe-integer offsets return -EINVAL (-28)
      expect(env.client.tryRead(handle, [afterBuf], -1)).toBe(-28);
      expect(env.client.tryWrite(handle, [encoder.encode("x")], -1)).toBe(-28);
      expect(env.client.tryRead(handle, [afterBuf], Number.NaN)).toBe(-28);
      expect(env.client.tryWrite(handle, [encoder.encode("x")], Number.POSITIVE_INFINITY)).toBe(
        -28,
      );

      env.client.release(handle);
      expect(env.client.completions.size).toBe(0);
    } finally {
      Atomics.wait = atomicsWait;
      FilesystemCompletion.prototype.wait = completionWait;
      await env.close();
    }
  });

  test("drainDiagnostic and CommandStdio work on redirected regular-file FDs", async () => {
    const env = await openVfsBackend(kind);
    try {
      const diag = await runInWorker<{ ok: boolean; text: string }>(
        "diagnostic",
        env.forkConnection(),
      );
      expect(diag).toEqual({ ok: true, text: "fatal: redirected diagnostic\n" });

      // CommandStdio on redirected regular file
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

describe("MultiTabBackend nonblocking remote I/O edge cases & cross-tab parity", () => {
  test("write invalidates stale completed remoteRead, overlapping mismatched writes serialize, and release cancels in-flight remote I/O", async () => {
    const env = await openVfsBackend("multitab-peer");
    try {
      await env.client.asyncCall("writeFile", ["/edge.txt", false, false], encoder.encode("v1"));
      const root: number = await env.client.asyncCall("preopen", ["/"]);
      const resolved = await env.client.asyncCall("resolve", [root, "edge.txt", true]);
      const handle = resolved.node as number;
      env.client.retain(handle);

      // Start a remoteRead and let it complete, then mutate via tryWrite BEFORE consuming the read.
      const staleBuf = new Uint8Array(8);
      expect(env.client.tryRead(handle, [staleBuf], 0)).toBe(-6);
      expect(env.client.ioPending(handle, false)).toBe(true);
      await waitReady(env.client, handle, false);
      expect(env.client.ioPending(handle, false)).toBe(false);

      // Mutate without consuming the ready remoteRead -> must invalidate stale read!
      expect(await completeTryWrite(env.client, handle, [encoder.encode("v2")], 0)).toBe(2);
      // Next tryRead must fetch fresh "v2", NOT stale "v1"!
      expect(env.client.tryRead(handle, [staleBuf], 0)).toBe(-6);
      await waitReady(env.client, handle, false);
      expect(env.client.tryRead(handle, [staleBuf], 0)).toBe(2);
      expect(decoder.decode(staleBuf.subarray(0, 2))).toBe("v2");

      // Overlapping mismatched write while first is in flight returns -6 without clobbering,
      // then submits the second write once the first finishes.
      expect(env.client.tryWrite(handle, [encoder.encode("AA")], 0)).toBe(-6);
      expect(env.client.ioPending(handle, true)).toBe(true);
      expect(env.client.tryWrite(handle, [encoder.encode("BB")], 0)).toBe(-6);
      await waitReady(env.client, handle, true);
      // First write finished; calling with "BB" now discards the unmatched completion and submits "BB".
      expect(env.client.tryWrite(handle, [encoder.encode("BB")], 0)).toBe(-6);
      await waitReady(env.client, handle, true);
      expect(env.client.tryWrite(handle, [encoder.encode("BB")], 0)).toBe(2);
      expect(decoder.decode(await env.client.asyncCall("readFile", ["/edge.txt"]))).toBe("BB");

      // Releasing the last local reference cancels in-flight remote I/O and frees completions.
      expect(env.client.tryRead(handle, [staleBuf], 0)).toBe(-6);
      expect(env.client.completions.size).toBe(1);
      env.client.release(handle);
      expect(env.client.completions.size).toBe(0);
    } finally {
      await env.close();
    }
  });

  test("Host and Peer tabs share live cooperative runtime_proc redirections without flush", async () => {
    const env = await openVfsBackend("multitab-peer");
    try {
      // Host writes /cross-tab.txt, Peer reads it live inside runtime_proc worker
      await env.peerClient!.asyncCall(
        "writeFile",
        ["/cross-tab.txt", false, false],
        encoder.encode("from-host-live"),
      );
      const peerResult = await runInWorker<{ ok: boolean; crossTabRead?: string }>(
        "proc-redirection",
        env.forkConnection("primary"),
        "from-host-live",
      );
      expect(peerResult.ok).toBe(true);
      expect(peerResult.crossTabRead).toBe("from-host-live");
      // Host immediately sees files created by Peer's runtime_proc redirects without flush!
      const outOnHost: Uint8Array = await env.peerClient!.asyncCall("readFile", ["/out.txt"]);
      expect(decoder.decode(outOnHost)).toBe("first\nsecond\n");
    } finally {
      await env.close();
    }
  });
});
