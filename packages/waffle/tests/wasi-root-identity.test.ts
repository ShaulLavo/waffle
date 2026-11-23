import { afterEach, expect, test } from "bun:test";
import { RIGHTS_ALL, RIGHT_FD_READ } from "../core/rights.js";
import { MemoryBackend } from "../fs/backend.js";
import { MemFS } from "../fs/memory.js";
import { createFilesystemConnection } from "../fs/protocol.js";
import { FilesystemService } from "../fs/service.js";
import { countingFs, createPathOpenHost } from "./fixtures/wasi-path-open-host.js";
import type { RootIdentityReport } from "./fixtures/wasi-root-identity-worker.js";

// A non-rooted guest sees descriptor aliases (`dev/null`, `dev/fd/N`) only from a directory that
// is the filesystem root. That check is a read-only `..` lookup, never `preopen("/")`, which over
// FilesystemClient is a mutation that bumps the shared epoch on every subdirectory open.

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

function seed(fs: MemFS): void {
  fs.writeFile("/volume/sub/hello.txt", "hello");
  fs.writeFile("/volume/dev/null", "physical-null");
  fs.writeFile("/volume/dev/fd/0", "volume-file");
}

function host(fs: MemFS, preopens: Record<string, string>) {
  const wrapped = countingFs(fs);
  const opened = createPathOpenHost(wrapped.fs, preopens);
  cleanup.push(() => opened.wasi.descriptors.dispose());
  const directory = (path: string) => {
    const result = opened.openRaw(3, path, { oflags: 2, base: RIGHTS_ALL });
    expect(result.errno).toBe(0);
    return result.fd;
  };
  const open = (dirfd: number, path: string) => {
    wrapped.reset();
    const result = opened.openRaw(dirfd, path, { base: RIGHT_FD_READ, inheriting: 0n });
    expect(wrapped.counts.preopen).toBe(0);
    if (result.errno) return { errno: result.errno };
    const kind = opened.wasi.descriptors.get(result.fd)!.resource.kind;
    const text = kind === "file" ? opened.readAll(result.fd) : undefined;
    expect(opened.close(result.fd)).toBe(0);
    return { errno: 0, kind, text };
  };
  return { directory, open, counts: wrapped.counts };
}

test("a `/` bound to a subdirectory opens its real dev entries, without fs.preopen", () => {
  const fs = new MemFS();
  seed(fs);
  const guest = host(fs, { "/": "/volume" });
  const sub = guest.directory("sub");
  const dot = guest.directory(".");
  expect(guest.open(sub, "hello.txt")).toEqual({ errno: 0, kind: "file", text: "hello" });
  // The `..` probe plus comparing its inode: the same stats the old preopen comparison made.
  expect(guest.counts).toEqual({ stat: 3, preopen: 0, permissions: 1, resolve: 2, create: 0 });
  expect(guest.open(sub, "missing/child")).toEqual({ errno: 44 });
  expect(guest.open(dot, "dev/fd/0")).toEqual({ errno: 0, kind: "file", text: "volume-file" });
  expect(guest.open(dot, "dev/null")).toEqual({ errno: 0, kind: "file", text: "physical-null" });
  // The `/` binding itself always spells the virtual names.
  expect(guest.open(3, "dev/null")).toEqual({ errno: 0, kind: "device", text: undefined });
});

test("the filesystem root bound under another name keeps its aliases, without fs.preopen", () => {
  const fs = new MemFS();
  seed(fs);
  const guest = host(fs, { "/work": "/" });
  const dot = guest.directory(".");
  const sub = guest.directory("volume");
  expect(guest.open(3, "dev/null")).toEqual({ errno: 0, kind: "device", text: undefined });
  expect(guest.open(dot, "dev/null")).toEqual({ errno: 0, kind: "device", text: undefined });
  // Below the root the same name is an ordinary entry again.
  expect(guest.open(sub, "dev/null")).toEqual({ errno: 0, kind: "file", text: "physical-null" });
});

test("a root without search permission reports EACCES whichever way the check goes", () => {
  const fs = new MemFS();
  seed(fs);
  const guest = host(fs, { "/work": "/" });
  const dot = guest.directory(".");
  expect(fs.setMode(fs.preopen("/"), 0o600)).toBe(0);
  expect(guest.open(dot, "dev/null")).toEqual({ errno: 2 });
  expect(guest.open(dot, "volume")).toEqual({ errno: 2 });
});

const publicationLimits = {
  sessions: 4,
  operations: 8,
  inputBytes: 64,
  argumentBytes: 512,
  effectBytes: 2048,
  effects: 16,
  resultBytes: 128,
  logRecords: 2,
  logBytes: 4096,
  pins: 2,
  pinBytes: 4096,
};

async function overClient(
  layout: "volume" | "aliased",
  publication: boolean,
): Promise<RootIdentityReport> {
  const backend = new MemoryBackend();
  seed(backend.fs);
  const service = new FilesystemService(backend);
  cleanup.push(() => service.dispose());
  const pair = createFilesystemConnection(
    undefined,
    publication ? { observe: true, limits: publicationLimits } : undefined,
  );
  service.connect(pair.server);
  const worker = new Worker(
    new URL("./fixtures/wasi-root-identity-worker.ts", import.meta.url).href,
  );
  cleanup.push(() => worker.terminate());
  return new Promise((resolve, reject) => {
    worker.onmessage = (event) => resolve(event.data as RootIdentityReport);
    worker.onerror = reject;
    worker.postMessage({ connection: pair.client, layout }, [pair.client.port]);
  });
}

function outcomes(report: RootIdentityReport) {
  for (const open of report.opens) expect(open.counts.preopen).toBe(0);
  return report.opens.map(({ label, errno, kind, text }) => ({ label, errno, kind, text }));
}

for (const publication of [false, true]) {
  test(`FilesystemClient subdirectory opens leave the epoch alone (publication=${publication})`, async () => {
    const report = await overClient("volume", publication);
    const file = { errno: 0, kind: "file" };
    expect(outcomes(report)).toEqual([
      { label: "sub file", ...file, text: "hello" },
      { label: "sub file", ...file, text: "hello" },
      { label: "sub file", ...file, text: "hello" },
      { label: "sub file", ...file, text: "hello" },
      { label: "sub missing", errno: 44, kind: undefined, text: undefined },
      { label: "dot dev/fd/0", ...file, text: "volume-file" },
      { label: "dot dev/null", ...file, text: "physical-null" },
      { label: "preopen dev/null", errno: 0, kind: "device", text: undefined },
    ]);
    // Publication serializes every request, reads included, so only the ordinary mode is quiet.
    if (!publication) expect(report.epochAfter).toBe(report.epochBefore);
  });

  test(`FilesystemClient root aliases survive a non-\`/\` binding (publication=${publication})`, async () => {
    const report = await overClient("aliased", publication);
    expect(outcomes(report)).toEqual([
      { label: "dot dev/fd/0", errno: 0, kind: "terminal", text: undefined },
      { label: "dot dev/null", errno: 0, kind: "device", text: undefined },
      { label: "preopen dev/null", errno: 0, kind: "device", text: undefined },
    ]);
    if (!publication) expect(report.epochAfter).toBe(report.epochBefore);
  });
}
