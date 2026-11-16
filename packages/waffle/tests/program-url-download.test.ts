import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test";
import { createRuntime, type Runtime } from "../index.js";
import { defineProgramPackage } from "../programs/index.js";
import { DescriptorTable } from "../core/descriptors.js";
import { createProgramShell } from "./fixtures/program-shell.js";
import { wasiCat } from "./fixtures/wasi-cat.js";

let runtime: Runtime | undefined;
let tables: DescriptorTable[] = [];
let cleanups: Array<() => void> = [];
const originalFetch = globalThis.fetch;
let fetchSpy: Mock<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>;
beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(async () => {
  for (const cleanup of cleanups) cleanup();
  await runtime?.dispose();
  runtime = undefined;
  for (const table of tables) table.dispose();
  tables = [];
  cleanups = [];
  fetchSpy.mockRestore();
});

async function create(
  maxDownloadBytes?: number,
  url = new URL("https://program.invalid/cat.wasm"),
) {
  const pkg = defineProgramPackage({
    name: "download",
    programs: [
      {
        path: "/usr/bin/cat",
        aliases: ["/bin/cat"],
        wasm: url,
        maxDownloadBytes,
      },
    ],
  });
  runtime = createRuntime({
    filesystem: { mode: "memory", workerURL: new URL("../browser/fs-worker.ts", import.meta.url) },
    programs: { onDemand: [pkg] },
  });
  await runtime.programs.ready;
  return runtime;
}

function failure(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function response(
  options: {
    chunks?: readonly Uint8Array[];
    length?: string;
    status?: number;
    cancel?: () => void | Promise<void>;
  } = {},
) {
  let pulls = 0;
  let cancellations = 0;
  const chunks = options.chunks ?? [];
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[pulls++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancellations++;
        return options.cancel?.();
      },
    },
    { highWaterMark: 0 },
  );
  const result = new Response(body, {
    status: options.status,
    headers: options.length === undefined ? {} : { "Content-Length": options.length },
  });
  return { result, pulls: () => pulls, cancellations: () => cancellations };
}

test("rejects the default advertised limit before pulling, even when cancellation throws", async () => {
  const fixture = response({
    length: String(256 * 1024 * 1024 + 1),
    cancel: () => {
      throw new Error("cleanup failed");
    },
  });
  fetchSpy.mockResolvedValue(fixture.result);
  const owner = await create();
  expect(await failure(owner.programs.preload("cat"))).toBeInstanceOf(RangeError);
  expect(fixture.pulls()).toBe(0);
  expect(fixture.cancellations()).toBe(1);
  expect(owner.programs.get("cat")?.state.kind).toBe("error");
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

for (const length of [undefined, "1", "invalid"]) {
  test(`bounds actual bytes with Content-Length ${length}, then explicitly recovers`, async () => {
    const bytes = wasiCat();
    const fixture = response({
      chunks: [bytes.subarray(0, 4), bytes.subarray(4), new Uint8Array([1])],
      length,
      cancel: () => Promise.reject(new Error("cleanup rejected")),
    });
    fetchSpy.mockResolvedValueOnce(fixture.result).mockResolvedValue(new Response(bytes));
    const owner = await create(bytes.byteLength);
    expect(await failure(owner.programs.preload("cat"))).toBeInstanceOf(RangeError);
    expect(fixture.cancellations()).toBe(1);
    expect(owner.programs.get("cat")?.state.kind).toBe("error");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await owner.programs.preload("/bin/cat");
    expect(owner.programs.get("cat")?.state.kind).toBe("loaded");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
}

test("accepts exactly the limit across chunks and ignores an understated length", async () => {
  const bytes = wasiCat();
  const fixture = response({ chunks: [bytes.subarray(0, 4), bytes.subarray(4)], length: "1" });
  fetchSpy.mockResolvedValue(fixture.result);
  const owner = await create(bytes.byteLength);
  await Promise.all([owner.programs.preload("cat"), owner.programs.preload("/bin/cat")]);
  expect(owner.programs.get("cat")?.state.kind).toBe("loaded");
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(fixture.cancellations()).toBe(0);
});

test("empty and one-byte chunks reconstruct the same executable", async () => {
  const bytes = wasiCat();
  const chunks = [new Uint8Array()].concat(Array.from(bytes, (byte) => new Uint8Array([byte])));
  const fixture = response({ chunks });
  fetchSpy.mockResolvedValue(fixture.result);
  const owner = await create(bytes.byteLength);
  await owner.programs.preload("cat");
  expect(owner.programs.get("cat")?.state.kind).toBe("loaded");
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

for (const status of [403, 404]) {
  test(`HTTP ${status} cancels the unread body and never automatically retries`, async () => {
    const fixture = response({ status, cancel: () => Promise.reject(new Error("cleanup")) });
    fetchSpy.mockResolvedValue(fixture.result);
    const owner = await create();
    expect(await failure(owner.programs.preload("cat"))).toMatchObject({
      message: `Program fetch failed: https://program.invalid/cat.wasm (${status})`,
    });
    expect(fixture.pulls()).toBe(0);
    expect(fixture.cancellations()).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
}

test("a network TypeError with an abort cause remains terminal until an explicit request", async () => {
  const error = new TypeError("fetch failed", { cause: new DOMException("aborted", "AbortError") });
  fetchSpy.mockRejectedValueOnce(error).mockResolvedValue(new Response(wasiCat()));
  const owner = await create();
  expect(await failure(owner.programs.preload("cat"))).toBe(error);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  await owner.programs.preload("cat");
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect(owner.programs.get("cat")?.state.kind).toBe("loaded");
});

test("a missing command and access queries never fetch", async () => {
  fetchSpy.mockImplementation(() => {
    throw new Error("unexpected fetch");
  });
  const owner = await create();
  const shell = await createProgramShell(owner, tables);
  expect(await shell.access("/bin/cat")).toBe(0);
  expect(await shell.access("/bin/missing")).toBeLessThan(0);
  expect(await shell.exec("/bin/missing", ["missing"])).toMatchObject({ error: "ENOENT" });
  expect(await failure(owner.programs.preload("missing"))).toBeInstanceOf(Error);
  expect(fetchSpy).not.toHaveBeenCalled();
});

function pendingBody(cancel: () => void | Promise<void> = () => {}) {
  const reading = Promise.withResolvers<void>();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
      },
      pull() {
        reading.resolve();
      },
      cancel() {
        cancellations++;
        return cancel();
      },
    },
    { highWaterMark: 0 },
  );
  cleanups.push(() => {
    try {
      controller.close();
    } catch {
      // A completed or canceled fixture has already closed its controller.
    }
  });
  return { body, reading: reading.promise, controller, cancellations: () => cancellations };
}

test("removal aborts a shared read and retains ownership until cancellation settles", async () => {
  const cleanup = Promise.withResolvers<void>();
  cleanups.push(() => cleanup.resolve());
  const fixture = pendingBody(() => cleanup.promise);
  let signal: AbortSignal | null | undefined;
  fetchSpy.mockImplementation(async (_url, options) => {
    signal = options?.signal;
    return new Response(fixture.body);
  });
  const owner = await create();
  const first = failure(owner.programs.preload("cat"));
  const second = failure(owner.programs.preload("/bin/cat"));
  await fixture.reading;
  let removed = false;
  const removal = owner.programs
    .get("cat")!
    .remove()
    .then(() => {
      removed = true;
    });
  await Promise.resolve();
  expect(signal?.aborted).toBe(true);
  expect(fixture.cancellations()).toBe(1);
  expect(removed).toBe(false);
  cleanup.resolve();
  await removal;
  expect(await first).toBeInstanceOf(DOMException);
  expect(await second).toBeInstanceOf(Error);
  expect(removed).toBe(true);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
}, 30_000);

test("removal aborts native fetch while headers are stalled", async () => {
  const requested = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<Response>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requested.resolve();
      return reply.promise;
    },
  });
  cleanups.push(() => {
    reply.resolve(new Response());
    server.stop(true);
  });
  fetchSpy.mockImplementation(originalFetch);
  const owner = await create(undefined, new URL("/cat.wasm", server.url));
  const loading = failure(owner.programs.preload("cat"));
  await requested.promise;
  await owner.programs.get("cat")!.remove();
  expect(await loading).toMatchObject({ name: "AbortError" });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
}, 30_000);

test("a fetch ignoring abort retains removal until its late response is canceled", async () => {
  const requested = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<Response>();
  const fixture = response({ cancel: () => Promise.reject(new Error("cleanup")) });
  cleanups.push(() => reply.resolve(fixture.result));
  let signal: AbortSignal | null | undefined;
  fetchSpy.mockImplementation(async (_url, options) => {
    signal = options?.signal;
    requested.resolve();
    return reply.promise;
  });
  const owner = await create();
  const loading = failure(owner.programs.preload("cat"));
  await requested.promise;
  let removed = false;
  const removal = owner.programs
    .get("cat")!
    .remove()
    .then(() => {
      removed = true;
    });
  await Promise.resolve();
  expect(signal?.aborted).toBe(true);
  expect(removed).toBe(false);
  reply.resolve(fixture.result);
  await removal;
  expect(await loading).toMatchObject({ name: "AbortError" });
  expect(fixture.pulls()).toBe(0);
  expect(fixture.cancellations()).toBe(1);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
}, 30_000);

test("runtime disposal aborts and joins a stalled body", async () => {
  const fixture = pendingBody(() => Promise.reject(new Error("cleanup")));
  fetchSpy.mockResolvedValue(new Response(fixture.body));
  const owner = await create();
  const loading = failure(owner.programs.preload("cat"));
  await fixture.reading;
  await owner.dispose();
  expect(await loading).toMatchObject({ name: "AbortError" });
  expect(fixture.cancellations()).toBe(1);
  runtime = undefined;
}, 30_000);

test("a streamed network failure keeps its identity when reader cancellation rejects", async () => {
  const error = new TypeError("network interrupted");
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(error);
    },
  });
  fetchSpy.mockResolvedValue(new Response(body));
  const owner = await create();
  expect(await failure(owner.programs.preload("cat"))).toBe(error);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(owner.programs.get("cat")?.state.kind).toBe("error");
});

test("invalid Wasm remains an admission failure and a later explicit load recovers", async () => {
  fetchSpy
    .mockResolvedValueOnce(new Response("not wasm"))
    .mockResolvedValue(new Response(wasiCat()));
  const owner = await create();
  expect(await failure(owner.programs.preload("cat"))).toMatchObject({ code: "ENOEXEC" });
  expect(owner.programs.get("cat")?.state.kind).toBe("error");
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  await owner.programs.preload("cat");
  expect(owner.programs.get("cat")?.state.kind).toBe("loaded");
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

for (const limit of [0, -1, NaN, Infinity, 1.5]) {
  test(`rejects invalid maxDownloadBytes ${limit} without fetching`, async () => {
    expect(await failure(create(limit))).toBeInstanceOf(RangeError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
}

test("canceling one execution leaves a joined preload alive", async () => {
  const fixture = pendingBody();
  let signal: AbortSignal | null | undefined;
  fetchSpy.mockImplementation(async (_url, options) => {
    signal = options?.signal;
    return new Response(fixture.body);
  });
  const owner = await create();
  const service = await owner.processes();
  const supervisor = await service.ready();
  const root = supervisor.createRoot();
  const child = supervisor.reserveSpawn(root, {
    executable: "/bin/cat",
    argv: ["cat"],
    env: {},
    cwd: "/",
    job: 0,
    fds: [],
  });
  const start = supervisor.start(child);
  await fixture.reading;
  const preload = owner.programs.preload("cat");
  await service.kill(child, 9);
  const exit = await supervisor.waitForExit(root, child);
  expect(signal?.aborted).toBe(false);
  expect(fixture.cancellations()).toBe(0);
  fixture.controller.enqueue(wasiCat());
  fixture.controller.close();
  await Promise.all([preload, start]);
  expect(exit).toMatchObject({ kind: "signaled", code: 9 });
  expect(owner.programs.get("cat")?.state.kind).toBe("loaded");
  expect(fetchSpy).toHaveBeenCalledTimes(1);
}, 30_000);
