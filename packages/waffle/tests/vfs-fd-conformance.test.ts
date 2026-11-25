import { describe, expect, test } from "bun:test";
import { DescriptorTable } from "../core/descriptors.js";
import { shareFileResource } from "../core/open-file.js";
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

describe("MultiTabBackend cross-tab live freshness and failover", () => {
  test("Host and Peer tabs share live cooperative runtime_proc redirections and cross-tab overwrites without stale reads", async () => {
    const env = await openVfsBackend("multitab-peer");
    try {
      await env.peerClient!.asyncCall(
        "writeFile",
        ["/cross-tab.txt", false, false],
        encoder.encode("v1-from-host"),
      );
      const peer1 = await runInWorker<{ ok: boolean; crossTabRead?: string }>({
        scenario: "proc-redirection",
        connection: env.forkConnection("primary"),
        seedText: "v1-from-host",
      });
      expect(peer1.ok).toBe(true);
      expect(peer1.crossTabRead).toBe("v1-from-host");

      // Host immediately sees files created by Peer's runtime_proc redirects without flush,
      // and overwriting /cross-tab.txt is observed freshly on the next Peer runtime_proc read!
      const outOnHost: Uint8Array = await env.peerClient!.asyncCall("readFile", ["/out.txt"]);
      expect(decoder.decode(outOnHost)).toBe("first\nsecond\n");

      await env.peerClient!.asyncCall(
        "writeFile",
        ["/cross-tab.txt", false, false],
        encoder.encode("v2-overwritten"),
      );
      const peer2 = await runInWorker<{ ok: boolean; crossTabRead?: string }>({
        scenario: "proc-redirection",
        connection: env.forkConnection("primary"),
        seedText: "v2-overwritten",
      });
      expect(peer2.ok).toBe(true);
      expect(peer2.crossTabRead).toBe("v2-overwritten");
    } finally {
      await env.close();
    }
  });

  test("Peer promotes to Host after graceful Host close and keeps cooperative runtime_proc redirections intact", async () => {
    const env = await openVfsBackend("multitab-peer");
    try {
      // Write via Peer while attached to Host.
      await env.peerClient!.asyncCall(
        "writeFile",
        ["/cross-tab.txt", false, false],
        encoder.encode("before-failover"),
      );
      const before = await runInWorker<{ ok: boolean; outText: string; crossTabRead?: string }>({
        scenario: "proc-redirection",
        connection: env.forkConnection("primary"),
        seedText: "before-failover",
      });
      expect(before.ok).toBe(true);
      expect(before.outText).toBe("first\nsecond\n");
      expect(before.crossTabRead).toBe("before-failover");

      // Gracefully close the Host tab; Peer must promote to Host and keep all prior files + FDs working.
      await env.closeCounterpart!();
      const after = await runInWorker<{ ok: boolean; outText: string; crossTabRead?: string }>({
        scenario: "proc-redirection",
        connection: env.forkConnection("primary"),
        seedText: "before-failover",
      });
      expect(after.ok).toBe(true);
      expect(after.outText).toBe("first\nsecond\n");
      expect(after.crossTabRead).toBe("before-failover");
      const persisted: Uint8Array = await env.client.asyncCall("readFile", ["/out.txt"]);
      expect(decoder.decode(persisted)).toBe("first\nsecond\n");
    } finally {
      await env.close();
    }
  });
});
