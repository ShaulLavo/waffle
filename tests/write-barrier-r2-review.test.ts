import { expect, test } from "bun:test";
import { MemoryBackend } from "../fs/backend";
import { FilesystemClient } from "../fs/client";
import { FilesystemService } from "../fs/service";
import { createFilesystemConnection, reapFilesystem, revokeFilesystem } from "../fs/protocol";
import { WRITE_BARRIER_OFFSET } from "../fs/write-barrier";
import { SharedFilesystem, ownerWriteBarrier } from "../browser/shared-fs";

const bytes = (value: string) => new TextEncoder().encode(value);
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const errnoOf = (error: unknown) =>
  typeof error === "object" && error && "errno" in error ? error.errno : String(error);
const log = (label: string, value: unknown) =>
  console.log(`[review60] ${label}: ${JSON.stringify(value)}`);

async function fixture(
  run: (f: {
    backend: MemoryBackend;
    service: FilesystemService;
    client: FilesystemClient;
    handle: number;
  }) => Promise<void>,
  backend = new MemoryBackend(),
) {
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  try {
    await client.asyncCall("writeFile", ["/shared"], bytes("before"));
    const root: number = await client.asyncCall("preopen", ["/"]);
    const path: { node: number } = await client.asyncCall("resolve", [root, "shared"]);
    client.retain(path.node);
    await run({ backend, service, client, handle: path.node });
  } finally {
    client.dispose();
    service.dispose();
    pair.server.port.close();
  }
}

function startWorker(client: FilesystemClient, mode: string, control: Int32Array) {
  const pair = client.fork();
  const worker = new Worker(new URL("./fixtures/write-barrier-r2-worker.ts", import.meta.url).href);
  const messages: unknown[] = [];
  const waiters: (() => void)[] = [];
  worker.onmessage = ({ data }) => {
    messages.push(data);
    for (const wake of waiters.splice(0)) wake();
  };
  worker.postMessage({ connection: pair, control: control.buffer, mode }, [pair.port]);
  const next = async (count: number) => {
    while (messages.length < count) await new Promise<void>((resolve) => waiters.push(resolve));
    return messages[count - 1];
  };
  const stop = async () => {
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
    await worker.terminate();
    reapFilesystem(pair);
  };
  return { next, stop };
}

test("R1 a new process identity cannot preopen an existing root while a lease is held", async () => {
  await fixture(async ({ service, client }) => {
    const lease = await service.pauseFilesystemWrites();
    const control = new Int32Array(new SharedArrayBuffer(8));
    const worker = startWorker(client, "spawn", control);
    try {
      const result = await worker.next(1);
      log("R1 worker preopen during lease", result);
      expect(result).toEqual({ preopen: 0 });
    } finally {
      await lease.release();
      await worker.stop();
    }
  });
});

test("R2 an ordinary EEXIST from an earlier mutation fails acquisition", async () => {
  const held = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  class Held extends MemoryBackend {
    loaded = false;
    prepare(operation: string, args: unknown[]) {
      if (operation !== "writeFile" || args[0] !== "/shared" || args[2] !== true) return;
      // A real cold load completes once; the requeued request must not prepare again.
      if (this.loaded) return;
      this.loaded = true;
      held.entered.resolve();
      return held.release.promise;
    }
  }
  const backend = new Held();
  await fixture(async ({ service, client }) => {
    const writing = client
      .asyncCall("writeFile", ["/shared", false, true], bytes("x"))
      .then(() => "ok", errnoOf);
    await held.entered.promise;
    const acquisition = service.pauseFilesystemWrites().then(
      async (lease) => {
        await lease.release();
        return "acquired";
      },
      (error) => ({ errno: errnoOf(error), message: (error as Error).message }),
    );
    await turn();
    held.release.resolve();
    const outcome = { write: await writing, acquisition: await acquisition };
    log("R2 earlier EEXIST then acquisition", outcome);
    expect(outcome.write).toBe(20);
    expect(outcome.acquisition).toBe("acquired");
    const retry = await service.pauseFilesystemWrites();
    await retry.release();
  }, backend);
});

test("R2b a handled page error from long before rejects a later unrelated acquisition", async () => {
  const filesystem = new SharedFilesystem({
    mode: "memory",
    workerURL: new URL("./fixtures/filesystem-default-service.ts", import.meta.url).href,
  });
  try {
    await filesystem.writeFile("/a", "1");
    const handled = await filesystem.writeFile("/a", "2", { exclusive: true }).catch(errnoOf);
    await filesystem.writeFile("/b", "3");
    const first = await filesystem[ownerWriteBarrier]().then(async (lease) => {
      await lease.release();
      return "acquired";
    }, errnoOf);
    const second = await filesystem[ownerWriteBarrier]().then(async (lease) => {
      await lease.release();
      return "acquired";
    }, errnoOf);
    log("R2b handled EEXIST, then two acquisitions", { handled, first, second });
    expect(handled).toBe(20);
    expect(first).toBe("acquired");
    expect(second).toBe("acquired");
  } finally {
    await filesystem.dispose();
  }
});

test("R3 a posted request dropped by session close leaks its ticket and acquisition never drains", async () => {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const page = new FilesystemClient(pair.client);
  const guestPair = createFilesystemConnection(pair.client);
  service.connect(guestPair.server);
  const guest = new FilesystemClient(guestPair.client);
  const abort = new AbortController();
  try {
    await page.asyncCall("writeFile", ["/shared"], bytes("before"));
    const completion = guest.submit("writeFile", ["/victim"], bytes("x"));
    revokeFilesystem(guestPair.client);
    service.sweep();
    await turn();
    await turn();
    completion.release();
    reapFilesystem(guestPair.client);
    await turn();
    const active = backend.shared.writeAdmission.active;
    const acquisition = service
      .pauseFilesystemWrites({ signal: abort.signal })
      .then(async (lease) => {
        await lease.release();
        return "acquired";
      }, errnoOf);
    const raced = await Promise.race([acquisition, sleep(1000).then(() => "still draining")]);
    abort.abort();
    const final = await acquisition;
    log("R3 after dropped request", {
      active,
      victim: backend.fs.readFile("/victim") ?? null,
      raced,
      final,
      activeAfterAbort: backend.shared.writeAdmission.active,
    });
    expect(active).toBe(0);
    expect(raced).toBe("acquired");
  } finally {
    abort.abort();
    guest.dispose();
    page.dispose();
    service.dispose();
    pair.server.port.close();
    guestPair.server.port.close();
  }
});

test("R4 more than 64 concurrent async mutations fail, and the burst starves other writers", async () => {
  await fixture(async ({ client, handle }) => {
    const writes = Array.from({ length: 100 }, (_, index) =>
      client.asyncCall("writeFile", [`/f${index}`], bytes("x")).then(() => 0, errnoOf),
    );
    const starved = client.tryWrite(handle, [bytes("guest")], 0);
    const results = await Promise.all(writes);
    const failed = results.filter((result) => result !== 0);
    log("R4 burst of 100 async writeFile", {
      failed: failed.length,
      errnos: Array.from(new Set(failed)),
      tryWriteDuringBurst: starved,
    });
    expect(failed.length).toBe(0);
    expect(starved).toBe(5);
  });
});

test("R4b SharedFilesystem Promise.all over 100 writeFile calls rejects some", async () => {
  const filesystem = new SharedFilesystem({
    mode: "memory",
    workerURL: new URL("./fixtures/filesystem-default-service.ts", import.meta.url).href,
  });
  try {
    await filesystem.writeFile("/ready", "1");
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        filesystem.writeFile(`/p${index}`, "x").then(() => 0, errnoOf),
      ),
    );
    const failed = results.filter((result) => result !== 0);
    log("R4b page Promise.all writeFile x100", {
      failed: failed.length,
      errnos: Array.from(new Set(failed)),
    });
    expect(failed.length).toBe(0);
  } finally {
    await filesystem.dispose();
  }
});

test("R5 acquisition rejects EAGAIN whenever any writer briefly holds the admission lock", async () => {
  await fixture(async ({ backend, service }) => {
    const lock = new Int32Array(backend.shared.buffer, WRITE_BARRIER_OFFSET, 1);
    Atomics.store(lock, 0, 12345);
    const releasing = setTimeout(() => {
      Atomics.store(lock, 0, 0);
      Atomics.notify(lock, 0);
    }, 20);
    const held = await service.pauseFilesystemWrites().then(
      async (lease) => {
        await lease.release();
        return "acquired";
      },
      (error) => ({ errno: errnoOf(error), message: (error as Error).message }),
    );
    clearTimeout(releasing);
    Atomics.store(lock, 0, 0);
    const free = await service.pauseFilesystemWrites().then(async (lease) => {
      await lease.release();
      return "acquired";
    }, errnoOf);
    log("R5 acquisition with admission lock held / free", { held, free });
    expect(held).toBe("acquired");
    expect(free).toBe("acquired");
  });
});

test("R6 blocking guest setMode/preopen return EAGAIN on admission-lock contention instead of waiting", async () => {
  await fixture(async ({ backend, client }) => {
    const control = new Int32Array(new SharedArrayBuffer(8));
    const worker = startWorker(client, "namespace", control);
    const lock = new Int32Array(backend.shared.buffer, WRITE_BARRIER_OFFSET, 1);
    try {
      expect(await worker.next(1)).toEqual({ ready: true });
      Atomics.store(lock, 0, 12345);
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0);
      await sleep(20);
      Atomics.store(control, 1, 1);
      Atomics.store(lock, 0, 0);
      Atomics.notify(lock, 0);
      const result = await worker.next(2);
      log("R6 worker namespace ops while admission lock held", result);
      expect(result).toMatchObject({ setMode: 0, preopen: 0, lockStillHeld: false });
    } finally {
      Atomics.store(lock, 0, 0);
      await worker.stop();
    }
  });
});

test("R7 admission serial exhaustion permanently disables every write", async () => {
  await fixture(async ({ backend, client, handle }) => {
    const cells = new Int32Array(backend.shared.buffer, WRITE_BARRIER_OFFSET, 8);
    Atomics.store(cells, 2, 0x7ffffffe);
    const first = client.tryWrite(handle, [bytes("a")], 0);
    const again = client.tryWrite(handle, [bytes("a")], 0);
    const page = await client.asyncCall("writeFile", ["/new"], bytes("x")).then(() => 0, errnoOf);
    log("R7 after 2^31-2 admissions", {
      first,
      again,
      page,
      active: backend.shared.writeAdmission.active,
    });
    expect([first, again, page]).toEqual([1, 1, 0]);
  });
});

test("R8 a pending page mutation loses the storage failure identity", async () => {
  const root = createFilesystemConnection();
  const client = new FilesystemClient(root.client);
  const fs = Object.assign(Object.create(SharedFilesystem.prototype), {
    client,
    worker: { terminate() {}, postMessage() {} },
    writes: Promise.resolve(),
    barrierRequests: new Map(),
    _state: { status: "opening" },
  }) as unknown as {
    fail(error: Error): void;
    writeFile(path: string, text: string): Promise<void>;
  };
  try {
    const writing = fs.writeFile("/x", "y").then(
      () => "ok",
      (error) => ({ errno: errnoOf(error), message: (error as Error).message }),
    );
    await turn();
    fs.fail(new Error("storage worker crashed"));
    const outcome = await writing;
    log("R8 pending writeFile after worker failure", outcome);
    expect(outcome).toMatchObject({ message: "storage worker crashed" });
  } finally {
    client.dispose();
    root.server.port.close();
  }
});
