import { createRuntime, createSharedControlAllocator, type Runtime } from "../../index.js";
import { DescriptorTable } from "../../core/descriptors.js";
import { RIGHT_FD_READ, RIGHT_FD_WRITE, RIGHT_POLL_FD_READWRITE } from "../../core/rights.js";
import type { OperationDiagnostics, OperationImage } from "../../browser/operations/types.js";
import { createRuntimeTerminalCodec } from "../../browser/runtime-terminals.js";
import { WorkerPipeHost } from "../../proc/worker-pipes.js";
import {
  createWorkerProcessTransport,
  workerProcessPipeRegistry,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../../proc/worker-client.js";
import type { IntrinsicsReport } from "./process-intrinsics.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const file = "File output.\n";
const piped = "Pipe output.\n";
const deadlineMs = 15_000;
const rights = RIGHT_FD_READ | RIGHT_POLL_FD_READWRITE;
const controlName = crypto.randomUUID();
const channel = new BroadcastChannel(controlName);
const notices: { kind: string; path: string; errno?: number | null; preopened?: boolean }[] = [];
channel.onmessage = ({ data }) => notices.push(data);
const workers: Worker[] = [];
declare global {
  interface Window {
    waitForOperationWorkerClose(number: number): Promise<void>;
  }
}
const NativeWorker = Worker;
const auditReports: IntrinsicsReport[] = [];
const resolveErrnos: number[] = [];
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    if (!String(url).includes("preview1-worker")) return;
    workers.push(this);
    this.addEventListener("message", ({ data }) => {
      if (data?.type === "operation-authority-audit") auditReports.push(data.report);
      if (data?.type === "operation-errno-audit") resolveErrnos.push(data.errno);
    });
  }
};

function ok(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}
function equal(actual: unknown, expected: unknown, detail: string) {
  ok(Object.is(actual, expected), `${detail}: ${JSON.stringify({ actual, expected })}`);
}
async function until<T>(probe: () => T | undefined | false, label: string): Promise<T> {
  const deadline = performance.now() + deadlineMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    ok(performance.now() < deadline, "Timed out waiting for " + label);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
function event(kind: string, path: string) {
  return until(() => {
    const at = notices.findIndex((notice) => notice.kind === kind && notice.path === path);
    if (at >= 0) return notices.splice(at, 1)[0];
  }, `${kind} ${path}`);
}
function recording(
  runtime: Runtime,
): Extract<OperationDiagnostics, { status: "recording" }> | undefined {
  const snapshot = runtime.operationDiagnostics?.();
  if (snapshot?.status === "recording") return snapshot;
}
function row(runtime: Runtime, pid: number): OperationImage | undefined {
  const snapshot = recording(runtime);
  return (
    snapshot?.owned.find((image) => image.pid === pid) ??
    snapshot?.departed.find((image) => image.pid === pid)
  );
}

async function createSession(runtime: Runtime) {
  const service = await runtime.processes();
  const transport = createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: runtime.identities.job(),
    identity: runtime.identities.buffer,
  });
  transport.data = { filesystem: runtime.filesystem.createIdentity() };
  let stdout = "",
    stderr = "";
  let output = Promise.withResolvers<void>();
  await service.adoptRuntimeRoot(transport, {
    memory: [],
    output(fd, bytes) {
      if (fd === 1) {
        stdout += decoder.decode(bytes);
        output.resolve();
        output = Promise.withResolvers();
      }
      if (fd === 2) stderr += decoder.decode(bytes);
    },
  });
  const messages: WorkerProcessMessage[] = [];
  const descriptors = new DescriptorTable();
  const postMessage = (message: WorkerProcessMessage) => {
    messages.push(message);
  };
  async function waitStdout(length: number) {
    const expired = Promise.withResolvers<never>();
    const timer = setTimeout(
      () => expired.reject(new Error("Timed out waiting for stdout")),
      deadlineMs,
    );
    try {
      while (stdout.length < length) await Promise.race([output.promise, expired.promise]);
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    const pipes = new WorkerPipeHost({
      allocateShared: createSharedControlAllocator(
        service.rootControlGrant(transport.pid),
        (buffer) => service.rootControlAllocated(transport.pid, buffer),
      ),
      transport,
      registry: workerProcessPipeRegistry(transport),
      postMessage,
    });
    for (const fd of [0, 1, 2]) {
      descriptors.openAt(
        fd,
        {
          kind: "terminal",
          read: () => 0,
          write: () => 0,
          readiness: () => ({ readable: true, writable: true, hangup: fd === 0 }),
        },
        rights | RIGHT_FD_WRITE,
        0n,
      );
    }
    const client = new WorkerProcessClient({
      transport,
      descriptors,
      codec: createRuntimeTerminalCodec({ descriptors, fallback: pipes.codec() }),
      prepareSpawn(pid) {
        pipes.registry.registerProcess(pid);
        return {
          data: {
            filesystem: runtime.filesystem.createIdentity(),
            pipeRegistry: pipes.registry.handle(),
          },
        };
      },
      postMessage,
    });
    const supervisor = await service.ready();
    async function flush() {
      for (;;) {
        const message = messages.shift();
        if (!message) return;
        await service.runtimeMessage(message, transport.pid);
      }
    }
    return {
      service,
      stdout: () => stdout,
      stderr: () => stderr,
      waitStdout,
      pipe() {
        const [read, write] = pipes.createPipe();
        const fd = descriptors.open(read, rights, 0n);
        return { fd, write, close: () => descriptors.close(fd) };
      },
      async spawn(args: string[], stdin = 0) {
        const pid = client.spawn(transport.pid, {
          executable: "/usr/bin/cat",
          argv: ["cat"].concat(args),
          cwd: "/",
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
          job: -1,
          fds: [stdin, 1, 2].map((parent, child) => ({ parent, child })),
        });
        await flush();
        await supervisor.start(pid);
        const exit = supervisor.waitForExit(transport.pid, pid).then(async (result) => {
          client.wait(transport.pid, pid);
          await flush();
          return result;
        });
        return { pid, exit };
      },
      dispose: () => descriptors.dispose(),
    };
  } catch (error) {
    descriptors.dispose();
    throw error;
  }
}
type Session = Awaited<ReturnType<typeof createSession>>;

async function blockedResolve(
  session: Session,
  path: string,
  action: "gate" | "transport" | "errno11" = "gate",
) {
  channel.postMessage({ kind: "arm", path, action });
  await event("armed", path);
  const child = await session.spawn(["/" + path]);
  equal((await event("held", path)).preopened, true, "exact session has finished its preopen");
  return child;
}
async function observed(
  runtime: Runtime,
  pid: number,
  kind: "pipeReadWait" | "fsResolve",
  phase: string,
) {
  return until(
    () => {
      const image = row(runtime, pid);
      return image?.[kind]?.active?.phase === phase ? image : undefined;
    },
    kind + " " + phase,
  );
}
async function waitExit(child: Awaited<ReturnType<Session["spawn"]>>, status: number) {
  const exit = await child.exit;
  equal(exit.kind, "exited", "guest exit kind");
  equal(exit.code, status, "guest exit code");
}
function send(writer: ReturnType<Session["pipe"]>["write"], text: string) {
  const data = encoder.encode(text);
  equal(writer.write([data]), data.length, "pipe write length");
}

async function positive(runtime: Runtime, session: Session) {
  const pipe = session.pipe();
  try {
    const reader = await session.spawn([], pipe.fd);
    await observed(runtime, reader.pid, "pipeReadWait", "waiting");
    const lookup = await blockedResolve(session, "input");
    const submitted = await observed(runtime, lookup.pid, "fsResolve", "submitted");
    channel.postMessage({ kind: "forward" });
    equal((await event("backend", "input")).errno, null, "resolve backend result");
    const accepted = await observed(runtime, lookup.pid, "fsResolve", "accepted");
    const acceptanceSnapshot = structuredClone(accepted);
    equal(accepted.captureId, submitted.captureId, "accepted capture");
    equal(row(runtime, reader.pid)?.pipeReadWait?.active?.phase, "waiting", "concurrent pipe wait");
    // Reentrant reads and caller failure must leave the active snapshot intact.
    const callerError = new Error("snapshot consumer");
    try {
      ok(Reflect.set(accepted.fsResolve!.active!, "phase", "submitted"), "mutable result copy");
      equal(recording(runtime)?.owned.length, 2, "reentrant snapshot");
      throw callerError;
    } catch (error) {
      equal(error, callerError, "caller exception identity");
    }
    equal(row(runtime, lookup.pid)?.fsResolve?.active?.phase, "accepted", "fresh snapshot copy");
    send(pipe.write, piped);
    pipe.write.close();
    await waitExit(reader, 0);
    equal(session.stdout(), piped, "pipe output and EOF");
    equal(row(runtime, reader.pid)?.pipeReadWait?.latest?.phase, "completed", "pipe settled");
    channel.postMessage({ kind: "release" });
    await waitExit(lookup, 0);
    equal(session.stdout(), piped + file, "exact combined stdout");
    equal(row(runtime, lookup.pid)?.fsResolve?.latest?.phase, "completed", "resolve settled");
    return {
      submitted,
      accepted: acceptanceSnapshot,
      pipe: row(runtime, reader.pid),
      resolve: row(runtime, lookup.pid),
    };
  } finally {
    channel.postMessage({ kind: "release" });
    pipe.write.close();
    pipe.close();
  }
}

async function failures(runtime: Runtime, session: Session) {
  const pipe = session.pipe();
  let interrupted: OperationImage["pipeReadWait"];
  try {
    const start = session.stdout().length;
    const child = await session.spawn([], pipe.fd);
    await observed(runtime, child.pid, "pipeReadWait", "waiting");
    send(pipe.write, "x".repeat(4096));
    await session.waitStdout(start + 4096);
    await until(() => {
      const wait = row(runtime, child.pid)?.pipeReadWait;
      return (wait?.completed === 1 && wait.active?.phase === "waiting") || undefined;
    }, "second pipe park");
    await session.service.kill(child.pid, 2);
    await waitExit(child, 130);
    equal(session.stdout().slice(start), "x".repeat(4096), "SIGINT prefix");
    interrupted = row(runtime, child.pid)?.pipeReadWait;
    equal(interrupted?.latest?.phase, "cancelled", "SIGINT settlement");
    equal(
      interrupted?.latest && "reason" in interrupted.latest && interrupted.latest.reason,
      "signal-pending",
      "SIGINT reason",
    );
  } finally {
    pipe.write.close();
    pipe.close();
  }
  const invalid = await blockedResolve(session, "input/child");
  channel.postMessage({ kind: "forward" });
  equal((await event("backend", "input/child")).errno, 54, "resolve returned ENOTDIR");
  await observed(runtime, invalid.pid, "fsResolve", "accepted");
  channel.postMessage({ kind: "release" });
  await waitExit(invalid, 1);
  equal(row(runtime, invalid.pid)?.fsResolve?.latest?.phase, "failed", "ENOTDIR settlement");

  const again = await blockedResolve(session, "input", "errno11");
  channel.postMessage({ kind: "forward" });
  equal((await event("backend", "input")).errno, 11, "numeric errno 11");
  await observed(runtime, again.pid, "fsResolve", "accepted");
  channel.postMessage({ kind: "release" });
  await waitExit(again, 1);
  const againResult = row(runtime, again.pid)?.fsResolve;
  equal(againResult?.latest?.phase, "failed", "numeric errno settlement");
  equal(againResult?.cancelled, 0, "numeric errno is not a cancellation");

  const broken = await blockedResolve(session, "input", "transport");
  await observed(runtime, broken.pid, "fsResolve", "submitted");
  channel.postMessage({ kind: "forward" });
  await waitExit(broken, 1);
  const failure = row(runtime, broken.pid)?.fsResolve?.latest;
  equal(failure && "reason" in failure && failure.reason, "transport-error", "transport failure");

  const revoked = await blockedResolve(session, "input");
  channel.postMessage({ kind: "forward" });
  await event("backend", "input");
  await observed(runtime, revoked.pid, "fsResolve", "accepted");
  const stopping = session.service.kill(revoked.pid, 9);
  await until(
    () => row(runtime, revoked.pid)?.fsResolve?.latest?.phase === "cancelled" || undefined,
    "revoked client before backend release",
  );
  channel.postMessage({ kind: "release" });
  await stopping;
  const killed = await revoked.exit;
  equal(killed.kind, "signaled", "revoked command outcome");
  equal(killed.code, 9, "revoked signal");

  const abandonedPipe = session.pipe();
  try {
    const abandoned = await session.spawn([], abandonedPipe.fd);
    await observed(runtime, abandoned.pid, "pipeReadWait", "waiting");
    const nativeClosed = window.waitForOperationWorkerClose(workers.length);
    workers.at(-1)!.terminate();
    let closed = false;
    void nativeClosed.then(() => {
      closed = true;
    });
    await until(() => closed || undefined, "native termination");
    await session.service.kill(abandoned.pid, 9);
    await abandoned.exit;
    const ended = await until(
      () => recording(runtime)?.departed.find((image) => image.pid === abandoned.pid),
      "abrupt worker retirement",
    );
    equal(ended.pipeReadWait?.retirement?.phase, "retired-unconfirmed", "abrupt retirement");
    equal(ended.pipeReadWait?.cancelled, 0, "abrupt cancellation count");
    return {
      interrupted,
      invalid: row(runtime, invalid.pid),
      again: row(runtime, again.pid),
      broken: row(runtime, broken.pid),
      revoked: row(runtime, revoked.pid),
      abandoned: ended,
      stderr: session.stderr(),
    };
  } finally {
    abandonedPipe.write.close();
    abandonedPipe.close();
  }
}

async function pair(runtime: Runtime, session: Session) {
  const pipe = session.pipe();
  let pipeMs: number;
  try {
    const child = await session.spawn([], pipe.fd);
    // Apply the same start gate on all revisions, including the uninstrumented baseline.
    await until(
      () =>
        session.service
          .startStates()
          .some((state) => state.pid === child.pid && state.step === "running") || undefined,
      "pipe guest entry",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const start = session.stdout().length;
    const wake = performance.now();
    send(pipe.write, piped);
    await session.waitStdout(start + piped.length);
    pipeMs = performance.now() - wake;
    pipe.write.close();
    await waitExit(child, 0);
    equal(session.stdout().slice(start), piped, "timed pipe bytes");
  } finally {
    pipe.write.close();
    pipe.close();
  }
  const start = session.stdout().length;
  const child = await blockedResolve(session, "input");
  channel.postMessage({ kind: "forward" });
  await event("backend", "input");
  const release = performance.now();
  channel.postMessage({ kind: "release" });
  await session.waitStdout(start + file.length);
  const resolveMs = performance.now() - release;
  await waitExit(child, 0);
  equal(session.stdout().slice(start), file, "timed file bytes");
  return { pipeMs, resolveMs, snapshots: timedSnapshots(runtime) };
}
function timedSnapshots(runtime: Runtime) {
  const start = performance.now();
  for (let index = 0; index < 100; index++) runtime.operationDiagnostics?.();
  return (performance.now() - start) / 100;
}

const search = new URL(location.href).searchParams;
const observeOperations = search.get("mode") === "on";
const audit = search.has("audit");

async function auditGuestAuthority(runtime: Runtime, session: Session) {
  const success = observeOperations ? await positive(runtime, session) : undefined;
  const broken = await blockedResolve(session, "input", "transport");
  channel.postMessage({ kind: "forward" });
  await waitExit(broken, 1);
  const errno = await until(() => resolveErrnos.at(-1), "guest transport errno");
  equal(errno, 29, "transport failure reached cat's filesystem with EIO");
  if (!observeOperations) return { success, errno };
  await until(() => auditReports.length === 3 || undefined, "guest authority audit reports");
  for (const report of auditReports) {
    ok(report.canaries.includes("Atomics.compareExchange"), "CAS canary missing");
    ok(report.canaries.includes("Atomics.load"), "load canary missing");
    equal(report.leaks.length, 0, "private buffer exposures");
  }
  return { success, errno };
}
const runtime = createRuntime({
  observeOperations,
  filesystem: {
    mode: "memory",
    workerURL: new URL("/operation-fs-worker.js?control=" + controlName, location.href),
  },
  programs: {
    preload: [
      {
        name: "coreutils",
        programs: [
          {
            path: "/usr/bin/cat",
            aliases: ["/bin/cat"],
            wasm: new URL("/cat.wasm", location.href),
          },
        ],
      },
    ],
  },
});
let session: Session | undefined;
try {
  ok(crossOriginIsolated, "Browser page is not isolated");
  if (runtime.operationDiagnostics)
    equal(
      runtime.operationDiagnostics().status,
      observeOperations ? "empty" : "disabled",
      "before activation",
    );
  await runtime.filesystem.writeFile("/input", file);
  await runtime.programs.ready;
  session = await createSession(runtime);
  const controls =
    observeOperations && search.has("controls") && !audit
      ? { positive: await positive(runtime, session), failures: await failures(runtime, session) }
      : undefined;
  const auditResult = audit ? await auditGuestAuthority(runtime, session) : undefined;
  const measurements = [];
  const samples = audit ? -1 : Number(search.get("samples") ?? "0");
  for (let index = 0; index <= samples; index++) {
    const sample = await pair(runtime, session);
    if (index !== 0) measurements.push(sample);
  }
  const snapshot = runtime.operationDiagnostics?.();
  const holders = runtime.sharedMemory
    .snapshot()
    .holders.filter((holder) => holder.label === "control" && holder.declaredBytes === 2560);
  equal(holders.length, observeOperations ? 1 : 0, "fixed diagnostics ledger charge");
  document.body.textContent = JSON.stringify({
    ok: true,
    controls,
    measurements,
    snapshot,
    holders,
    auditReports,
    auditResult,
  });
} catch (error) {
  document.body.textContent = JSON.stringify({
    ok: false,
    error: String(error),
    stack: (error as Error).stack,
  });
} finally {
  channel.postMessage({ kind: "release" });
  try {
    session?.dispose();
    await runtime.dispose();
    document.body.dataset.disposed = "true";
  } finally {
    channel.close();
    document.body.dataset.done = "true";
  }
}
