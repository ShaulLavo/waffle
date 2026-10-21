import { SharedFilesystem } from "../browser/shared-fs.js";
import {
  localPublication,
  publicationObserver,
  type PublicationLimits,
} from "../fs/publication-internal.js";
import type { FilesystemConnection } from "../fs/protocol.js";

const limits: PublicationLimits = {
  sessions: 8,
  operations: 16,
  inputBytes: 64,
  argumentBytes: 1024,
  effectBytes: 8192,
  effects: 32,
  resultBytes: 128,
  logRecords: 16,
  logBytes: 131072,
  pins: 2,
  pinBytes: 128,
};
function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
function message(worker: Worker, value: unknown, transfer: Transferable[] = []): Promise<unknown> {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data?.failure) reject(new Error(data.failure));
      else resolve(data);
    };
    worker.onerror = (event) => reject(new Error(event.message));
    worker.onmessageerror = () => reject(new Error("Invalid publication worker response"));
    worker.postMessage(value, transfer);
  });
}
export async function runPublicationBrowser(): Promise<string[]> {
  const passed: string[] = [];
  const ordinary = new SharedFilesystem({ mode: "memory", workerURL: "/fs-worker.js" });
  try {
    await ordinary.writeFile("/ordinary", "plain");
    equal(ordinary.client.connection.publication, undefined);
    equal(Array.from((await ordinary.readFile("/ordinary"))!), [112, 108, 97, 105, 110]);
    passed.push("uninstrumented root has no publication domain");
  } finally {
    await ordinary.dispose();
  }
  const fs = new SharedFilesystem({
    mode: "memory",
    workerURL: "/fs-worker.js",
    [localPublication]: { limits, observe: true },
  });
  const workers: Worker[] = [],
    connections: FilesystemConnection[] = [];
  try {
    const source = new Uint8Array([1, 2, 3]);
    const queued = fs.writeFile("/file", source);
    source.fill(99);
    await queued;
    equal(Array.from((await fs.readFile("/file"))!), [1, 2, 3]);
    passed.push("page owns input before its promise queue");
    const observer = publicationObserver(fs.client);
    const start = await observer.cut();
    for (const mode of ["wasi", "proc"]) {
      const worker = new Worker("/guest.js", { type: "module" }),
        connection = fs.fork();
      workers.push(worker);
      connections.push(connection);
      equal(connection.publication?.observer, undefined);
      equal(await message(worker, { connection, mode }, [connection.port]), { ready: true });
    }
    equal(await message(workers[0]!, { operation: "write", byte: 8 }), {
      result: 0,
      offset: 0,
      byte: 8,
      count: 1,
    });
    equal(Array.from((await fs.readFile("/file"))!), [8, 2, 3]);
    await fs.writeFile("/file", new Uint8Array([7, 6, 5]));
    equal(await message(workers[1]!, { operation: "read", byte: 42 }), {
      result: 1,
      offset: 1,
      byte: 7,
      count: 0xdeadbeef,
    });
    equal(await message(workers[1]!, { operation: "write", byte: 9 }), {
      result: 1,
      offset: 2,
      byte: 9,
      count: 0xdeadbeef,
    });
    const changes = await observer.changes(start, limits.logBytes);
    equal(changes.kind, "changes");
    if (changes.kind !== "changes") throw new Error("Unexpected publication gap");
    equal(changes.publications.length, 3);
    equal(
      changes.publications.map(
        (entry: { receipt: { cut: { generation: number } } }) => entry.receipt.cut.generation,
      ),
      [start.generation + 1, start.generation + 2, start.generation + 3],
    );
    equal(Array.from((await fs.readFile("/file"))!), [7, 9, 5]);
    passed.push(
      "separate real WASI and runtime_proc workers publish before explicit cuts without nudges",
    );
    const before = await observer.cut();
    Atomics.store(fs.client.shared.cells, 1, 99);
    try {
      equal(await message(workers[1]!, { operation: "write", byte: 10 }), {
        result: -6,
        offset: 2,
        byte: 10,
        count: 0xdeadbeef,
      });
      equal(await message(workers[1]!, { operation: "read", byte: 42 }), {
        result: -6,
        offset: 2,
        byte: 42,
        count: 0xdeadbeef,
      });
    } finally {
      Atomics.store(fs.client.shared.cells, 1, 0);
    }
    equal(await observer.cut(), before);
    passed.push("real runtime_proc contention preserves output offset and publication cut");
    await fs.move("/file", "/moved");
    equal(await message(workers[1]!, { operation: "write", byte: 4 }), {
      result: 1,
      offset: 3,
      byte: 4,
      count: 0xdeadbeef,
    });
    equal(Array.from((await fs.readFile("/moved"))!), [7, 9, 4]);
    const directory = await fs.client.asyncCall("preopen", ["/"]);
    const path = await fs.client.asyncCall("resolve", [directory, "moved"]);
    fs.client.retain(path.node);
    const pin = await observer.pin(path.node, 0, 3);
    await fs.client.asyncCall("setMode", [path.node, 0o400]);
    equal(await message(workers[1]!, { operation: "write", byte: 10 }), {
      result: -2,
      offset: 3,
      byte: 10,
      count: 0xdeadbeef,
    });
    await fs.client.asyncCall("setMode", [path.node, 0o600]);
    await fs.remove("/moved");
    equal(await message(workers[1]!, { operation: "read", byte: 42 }), {
      result: 0,
      offset: 3,
      byte: 42,
      count: 0xdeadbeef,
    });
    equal(pin.bytes, [7, 9, 4]);
    await observer.releasePin(pin.id);
    passed.push("rename unlink permissions and copied pins retain inode identity");
    for (const worker of workers) equal(await message(worker, "stop"), { stopped: true });
    passed.push("workers acknowledge their own filesystem teardown");
    return passed;
  } finally {
    Atomics.store(fs.client.shared.cells, 1, 0);
    for (const worker of workers) worker.terminate();
    for (const connection of connections) fs.reap(connection);
    await fs.dispose();
  }
}
