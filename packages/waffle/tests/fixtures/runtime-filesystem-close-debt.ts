import { testSharedMemory } from "./shared-memory-platform.js";
import { createRuntime, type Runtime } from "../../index.js";
import { MemoryBackend } from "../../fs/backend.js";
import { FilesystemService } from "../../fs/service.js";
import type { FilesystemConnection } from "../../fs/protocol.js";
import { withVfsImplementation } from "../../fs/vfs-internal.js";

export const runtimeFilesystemCloseDebtPath = import.meta.filename;

function failureFor(kind: string): unknown {
  switch (kind) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "false":
      return false;
    case "zero":
      return 0;
    case "empty":
      return "";
    case "object":
      return Object.freeze({ close: "original" });
    default:
      return new Error("original filesystem disposal failed");
  }
}
function observe(pending: Promise<void>) {
  return pending.then(
    () => ({ kind: "fulfilled" as const }),
    (reason: unknown) => ({ kind: "rejected" as const, reason }),
  );
}
class CloseBoundary extends EventTarget {
  readonly service = new FilesystemService(new MemoryBackend());
  readonly started = Promise.withResolvers<void>();
  readonly completion = Promise.withResolvers<void>();
  readonly ports: MessagePort[] = [];
  closes = 0;
  terminations = 0;
  onClose = () => {};
  constructor(
    private readonly reject: boolean,
    private readonly failure: unknown,
  ) {
    super();
  }
  postMessage(message: { connect?: FilesystemConnection; dispose?: true }) {
    if (message.connect) {
      this.ports.push(message.connect.port);
      this.service.connect(message.connect);
      this.dispatchEvent(
        new MessageEvent("message", { data: { type: "filesystem-state", status: "ready" } }),
      );
      return;
    }
    if (!message.dispose) return;
    this.closes++;
    this.started.resolve();
    this.onClose();
    // This unit seam keeps falsy in-realm transport rejections, which the worker wire diagnoses as text.
    if (this.reject) throw this.failure;
    void this.completion.promise.then(() => this.service.shutdown()).then(() => this.acknowledge());
  }
  acknowledge() {
    this.dispatchEvent(new MessageEvent("message", { data: { type: "filesystem-disposed" } }));
  }
  terminate() {
    if (!Reflect.has(globalThis, Symbol.for("waffle.runtime.owner")))
      throw new Error("Page guard released before filesystem termination");
    this.terminations++;
    this.service.dispose();
  }
  cleanup() {
    this.service.dispose();
    for (const port of this.ports) port.close();
  }
}
async function exercise(mode: string, reason: unknown, boundary: CloseBoundary) {
  const runtime = createRuntime({
    sharedMemory: testSharedMemory,
    filesystem: withVfsImplementation("indexeddb", { workerURL: "https://fixture.invalid/fs.js" }),
  });
  await runtime.filesystem.writeFile("/marker", "close debt");
  const token = Reflect.get(globalThis, Symbol.for("waffle.runtime.owner"));
  let nested: Promise<void> | undefined;
  boundary.onClose = () => {
    nested = runtime.dispose();
  };
  const disposal = runtime.dispose();
  const result = observe(disposal);
  await boundary.started.promise;
  const pendingGuard = Reflect.get(globalThis, Symbol.for("waffle.runtime.owner")) === token;
  boundary.completion.resolve();
  const settled = await result;
  boundary.acknowledge();
  await Promise.resolve();
  const repeated = await observe(runtime.dispose());
  const sameToken = Reflect.get(globalThis, Symbol.for("waffle.runtime.owner")) === token;
  const closes = boundary.closes;
  const terminations = boundary.terminations;
  let next: Runtime | undefined;
  let blocked = false;
  try {
    next = createRuntime({
      sharedMemory: testSharedMemory,
      filesystem: { mode: "memory", workerURL: "https://fixture.invalid/next.js" },
    });
  } catch (error) {
    blocked = error instanceof Error && /live page runtime/.test(error.message);
  }
  await next?.dispose();
  return {
    rejected: settled.kind === "rejected",
    originalReason: settled.kind === "rejected" && Object.is(settled.reason, reason),
    sameRejection:
      settled.kind === "rejected" &&
      repeated.kind === "rejected" &&
      Object.is(settled.reason, repeated.reason),
    samePromise: runtime.dispose() === disposal && nested === disposal,
    pendingGuard,
    sameToken,
    blocked,
    closes,
    terminations,
    success: mode === "success" && settled.kind === "fulfilled",
  };
}
async function run(mode: string) {
  const reason = failureFor(mode);
  const boundary = new CloseBoundary(mode !== "success", reason);
  const original = globalThis.Worker;
  globalThis.Worker = class {
    constructor() {
      return boundary;
    }
  } as unknown as typeof Worker;
  try {
    return await exercise(mode, reason, boundary);
  } finally {
    boundary.cleanup();
    globalThis.Worker = original;
  }
}
if (import.meta.main) console.log(JSON.stringify(await run(process.argv[2] ?? "error")));
