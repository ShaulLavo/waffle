import { afterEach, expect, test } from "bun:test";
import { SharedFilesystem, type SharedFilesystemOptions } from "../browser/shared-fs.js";
import {
  FilesystemError,
  FilesystemSection,
  type FilesystemConnection,
} from "../fs/protocol.js";
import { localPublication, type PublicationLimits } from "../fs/publication-internal.js";

type PageMessage = { connect?: FilesystemConnection; dispose?: true };
type WorkerEvent = { data?: unknown; message?: string; preventDefault(): void };
const previousWorker = globalThis.Worker;
const workers: PageWorkerStandIn[] = [];
const fixtures: { cleanup(): Promise<void> }[] = [];

// This stand-in injects the existing service wire ACK. It proves page ownership only,
// not native service/storage closure, persistence, or original Worker death.
class PageWorkerStandIn {
  readonly messages: PageMessage[] = [];
  readonly listeners = new Map<string, ((event: WorkerEvent) => void)[]>();
  terminations = 0;
  postFailure?: { reason: unknown };
  constructor() {
    workers.push(this);
  }
  addEventListener(type: string, listener: (event: WorkerEvent) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).concat([listener]));
  }
  postMessage(message: PageMessage): void {
    this.messages.push(message);
    if (message.dispose && this.postFailure) throw this.postFailure.reason;
  }
  terminate(): void {
    this.terminations++;
  }
  emit(type: string, data?: unknown): void {
    const event = { data, message: "original worker error", preventDefault() {} };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  ready(): void {
    this.emit("message", { type: "filesystem-state", status: "ready" });
  }
  acknowledge(error?: string): void {
    this.emit("message", { type: "filesystem-disposed", ...(error === undefined ? {} : { error }) });
  }
  fault(type: string): void {
    if (type === "error" || type === "messageerror") return this.emit(type);
    this.emit("message", { type, message: "original service failure" });
  }
  get requests(): number {
    return this.messages.filter((message) => message.dispose).length;
  }
}

function fixture(options: SharedFilesystemOptions = {}) {
  globalThis.Worker = PageWorkerStandIn as unknown as typeof Worker;
  const fs = new SharedFilesystem({ workerURL: "https://example.test/fs.js", ...options });
  const worker = workers.at(-1)!;
  const releases: (() => void)[] = [];
  const value = {
    fs,
    worker,
    hold() {
      const section = new FilesystemSection(fs.client.connection);
      section.enter();
      let held = true;
      const release = () => {
        if (!held) return;
        held = false;
        section.exit();
      };
      releases.push(release);
      return release;
    },
    async cleanup() {
      for (const release of releases) release();
      const stopping = fs.dispose();
      worker.acknowledge();
      await stopping.catch(() => {});
      // Explicit fixture reclamation is not a successful failed-owner disposal receipt.
      fs.client.dispose();
      for (const message of worker.messages) message.connect?.port.close();
    },
  };
  fixtures.push(value);
  return value;
}

afterEach(async () => {
  try {
    for (const value of fixtures.splice(0)) await value.cleanup();
  } finally {
    workers.length = 0;
    globalThis.Worker = previousWorker;
  }
});

async function checkpoint(): Promise<void> {
  const turn = new MessageChannel();
  try {
    await new Promise<void>((resolve) => {
      turn.port1.onmessage = () => resolve();
      turn.port2.postMessage(null);
    });
  } finally {
    turn.port1.close();
    turn.port2.close();
  }
}
function observe(promise: Promise<void>) {
  let settled = false;
  const result = promise.then(
    () => ({ kind: "fulfilled" as const }),
    (reason: unknown) => ({ kind: "rejected" as const, reason }),
  );
  void result.then(() => {
    settled = true;
  });
  return { result, get settled() { return settled; } };
}
function expectRetained(fs: SharedFilesystem, worker: PageWorkerStandIn): void {
  expect(worker.terminations).toBe(0);
  expect(new Int32Array(fs.client.connection.revocations[0]!)[0]).not.toBe(2);
  expect(new Int32Array(fs.client.connection.ownerStates)[fs.client.connection.owner]).not.toBe(2);
}

for (const first of ["ack", "section"] as const) {
  test(`ready ordinary disposal joins the original ${first}-first close and root fence`, async () => {
    const { fs, worker, hold } = fixture();
    worker.ready();
    const release = hold();
    const stopping = fs.dispose();
    const outcome = observe(stopping);
    expect(fs.dispose()).toBe(stopping);
    expect(worker.requests).toBe(1);
    expect(fs.state.status).toBe("ready");
    expectRetained(fs, worker);
    expect(() => new FilesystemSection(fs.client.connection).enter()).toThrow(FilesystemError);
    if (first === "ack") worker.acknowledge();
    else release();
    await checkpoint();
    expect(outcome.settled).toBe(false);
    expectRetained(fs, worker);
    if (first === "ack") release();
    else worker.acknowledge();
    await stopping;
    expect(fs.state.status).toBe("disposed");
    expect(worker.terminations).toBe(1);
    expect(new Int32Array(fs.client.connection.revocations[0]!)[0]).toBe(2);
    worker.acknowledge();
    worker.ready();
    expect(fs.dispose()).toBe(stopping);
    expect(worker.requests).toBe(1);
    expect(worker.terminations).toBe(1);
    expect(fs.state.status).toBe("disposed");
  });
}

test("ready and disposed observers reenter one disposal after synchronous admission cutoff", async () => {
  const { fs, worker } = fixture();
  let first: Promise<void> | undefined;
  let repeated: Promise<void> | undefined;
  let admissionFailure: unknown;
  fs.onStateChange = (state) => {
    if (state.status === "disposed") repeated = fs.dispose();
    if (state.status !== "ready") return;
    first = fs.dispose();
    const section = new FilesystemSection(fs.client.connection);
    try {
      section.enter();
      section.exit();
    } catch (error) {
      admissionFailure = error;
    }
  };
  worker.ready();
  expect(first).toBeDefined();
  expect(admissionFailure).toBeInstanceOf(FilesystemError);
  expect(worker.requests).toBe(1);
  expectRetained(fs, worker);
  worker.acknowledge();
  await first;
  expect(repeated).toBe(first);
  expect(worker.terminations).toBe(1);
});

test("ready disposal cancels queued and new page mutations without reaping the original client", async () => {
  const { fs, worker } = fixture();
  worker.ready();
  const before = fs.mkdirp("/queued").catch((reason: unknown) => reason);
  const stopping = fs.dispose();
  const after = fs.writeFile("/late", "not admitted").catch((reason: unknown) => reason);
  expect(await before).toMatchObject({ errno: 11 });
  expect(await after).toMatchObject({ errno: 11 });
  expectRetained(fs, worker);
  worker.acknowledge();
  await stopping;
});

test("an error ACK retains the original failed owner despite section exit and duplicate success", async () => {
  const { fs, worker, hold } = fixture();
  worker.ready();
  const release = hold();
  const stopping = fs.dispose();
  const outcome = observe(stopping);
  worker.acknowledge("original service close failed");
  const result = await outcome.result;
  expect(result).toMatchObject({ kind: "rejected", reason: { message: "original service close failed" } });
  expect(fs.state.status).toBe("failed");
  expectRetained(fs, worker);
  release();
  worker.acknowledge();
  worker.acknowledge("later unrelated failure");
  await checkpoint();
  expect(fs.dispose()).toBe(stopping);
  expect(await observe(fs.dispose()).result).toEqual(result);
  expect(worker.requests).toBe(1);
  expectRetained(fs, worker);
});

for (const reason of [new Error("original postMessage failure"), undefined, null, false, 0, ""]) {
  test(`ready postMessage throw retains its exact original ${String(reason)} rejection`, async () => {
    const { fs, worker } = fixture();
    worker.ready();
    worker.postFailure = { reason };
    const stopping = fs.dispose();
    const result = await observe(stopping).result;
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reason).toBe(reason);
    expect(fs.dispose()).toBe(stopping);
    worker.acknowledge();
    await checkpoint();
    expect(worker.requests).toBe(1);
    expectRetained(fs, worker);
  });
}

for (const type of ["error", "messageerror", "filesystem-error", "filesystem-ownership-lost"]) {
  for (const at of ["before-dispose", "pending-ack", "ack-with-held-root"] as const) {
    test(`${type} at ${at} retains one original ready disposal failure`, async () => {
      const { fs, worker, hold } = fixture();
      worker.ready();
      const release = hold();
      let ownershipLost = 0;
      fs.onOwnershipLost = () => { ownershipLost++; };
      if (at === "before-dispose") worker.fault(type);
      const stopping = fs.dispose();
      const outcome = observe(stopping);
      if (at === "ack-with-held-root") worker.acknowledge();
      if (at !== "before-dispose") worker.fault(type);
      const result = await outcome.result;
      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") expect(result.reason).toBe(fs.state.error);
      expect(fs.state.status).toBe("failed");
      expectRetained(fs, worker);
      expect(worker.requests).toBe(at === "before-dispose" ? 0 : 1);
      expect(ownershipLost).toBe(type === "filesystem-ownership-lost" ? 1 : 0);
      if (type === "filesystem-ownership-lost") expect(fs.ownershipLost).toBe(true);
      release();
      worker.acknowledge();
      worker.ready();
      await checkpoint();
      expect(fs.dispose()).toBe(stopping);
      expect(await observe(fs.dispose()).result).toEqual(result);
      expectRetained(fs, worker);
    });
  }
}

test("a success ACK cannot lock out an error ACK before the original root fence", async () => {
  const { fs, worker, hold } = fixture();
  worker.ready();
  const release = hold();
  const stopping = fs.dispose();
  const outcome = observe(stopping);
  worker.acknowledge();
  await checkpoint();
  expect(outcome.settled).toBe(false);
  worker.acknowledge("close failure before original root exit");
  const result = await outcome.result;
  expect(result).toMatchObject({
    kind: "rejected",
    reason: { message: "close failure before original root exit" },
  });
  expectRetained(fs, worker);
  release();
  worker.acknowledge();
  await checkpoint();
  expect(fs.dispose()).toBe(stopping);
  expect(await observe(fs.dispose()).result).toEqual(result);
  expectRetained(fs, worker);
});

test("missing or malformed wire success never completes ready ordinary disposal", async () => {
  const { fs, worker } = fixture();
  worker.ready();
  const stopping = fs.dispose();
  const outcome = observe(stopping);
  for (const message of [
    null,
    {},
    { type: "filesystem-disposed", error: false },
    { type: "filesystem-disposed", error: null },
    { type: "filesystem-disposed", error: {} },
  ]) worker.emit("message", message);
  await checkpoint();
  expect(outcome.settled).toBe(false);
  expectRetained(fs, worker);
  worker.acknowledge();
  await stopping;
});

test("ready disposal rejects new identity, fork, connect and real section admission", async () => {
  const { fs, worker } = fixture();
  worker.ready();
  const identity = fs.createIdentity();
  const stopping = fs.dispose();
  expect(() => fs.createIdentity()).toThrow(FilesystemError);
  expect(() => fs.fork()).toThrow(FilesystemError);
  expect(() => fs.connect(identity)).toThrow(FilesystemError);
  expect(() => new FilesystemSection(identity).enter()).toThrow(FilesystemError);
  expectRetained(fs, worker);
  worker.acknowledge();
  await stopping;
});

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
for (const options of [
  { mode: "memory" },
  { mode: "memory", [localPublication]: { limits } },
  { [localPublication]: { limits } },
] satisfies SharedFilesystemOptions[]) {
  test(`ready ${options.mode ?? "persistent"} publication=${localPublication in options} keeps its existing stop path`, async () => {
    const { fs, worker } = fixture(options);
    worker.ready();
    const stopping = fs.dispose();
    expect(worker.requests).toBe(0);
    expect(worker.terminations).toBe(1);
    await stopping;
    expect(fs.dispose()).toBe(stopping);
  });
}
