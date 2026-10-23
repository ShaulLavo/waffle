import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { DescriptorTable, type Stream } from "../core/descriptors.js";
import { MemFS } from "../fs/memory.js";
import { ProcessABI } from "../proc/abi.js";
import { claimOutcome } from "../proc/outcome.js";
import { collectDirectoryProcess, confirmDirectoryProcess } from "../proc/directory.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
  type WorkerProcessTransport,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import { signalPending, takeSignal } from "../proc/signals.js";
import { PipeController } from "../proc/pipes.js";
import { poisonProcessIntrinsics, type IntrinsicsReport } from "./fixtures/process-intrinsics.js";
import {
  createRuntimeTerminalCodec,
  createTerminalSession,
  claimTerminalAuthority,
  attachTerminal,
  terminalControls,
  TERMINAL_SESSION_LIMITS,
  type TerminalContext,
  type TerminalPolicy,
  type TerminalResult,
  type TerminalTurn,
} from "../browser/runtime-terminals.js";

function must<T>(result: TerminalResult<T>): T {
  if (result.kind === "error") throw new Error(result.code);
  return result.value;
}
// Only the test policy owns bytes. Both worker policies use this SAME shared FIFO.
function tinyPolicy(buffer: SharedArrayBuffer): TerminalPolicy {
  const cells = new Int32Array(buffer);
  return {
    inputReadiness: () => ({ readable: cells[0] !== cells[1], nbytes: cells[1]! - cells[0]! }),
    tryRead(_turn, chunks) {
      let count = 0;
      for (const chunk of chunks) {
        const read = readChunk(cells, chunk, count);
        count += read.count;
        if (read.eof) return count;
      }
      return count || -6;
    },
    transition(_turn, change) {
      if (change.kind === "selection") cells[0] = cells[1]!;
      return { kind: "ok", value: undefined };
    },
    tryWrite: (_target, chunks) => chunks.reduce((n, bytes) => n + bytes.length, 0),
    outputReadiness: () => ({ writable: true }),
  };
}
function readChunk(cells: Int32Array, chunk: Uint8Array, previous: number) {
  let count = 0;
  for (let offset = 0; offset < chunk.length && cells[0] !== cells[1]; offset++) {
    const token = cells[4 + (cells[0]! % 128)]!;
    if (token === 0) {
      if (count + previous === 0) cells[0]!++;
      return { count, eof: true };
    }
    chunk[offset] = token - 1;
    cells[0]!++;
    count++;
  }
  return { count, eof: false };
}
function fixture(
  policyOverride?: (buffer: SharedArrayBuffer) => TerminalPolicy,
  checks: { authority?: () => void; endpoint?: () => void } = {},
) {
  const root = createWorkerProcessTransport({ capacity: 64 });
  const buffer = new SharedArrayBuffer(132 * 4),
    cells = new Int32Array(buffer);
  const policy = policyOverride ? policyOverride(buffer) : tinyPolicy(buffer);
  const display = createTerminalSession({ controller: root, geometry: { columns: 120, rows: 24 } });
  const attachment = attachTerminal({
    context: display.inherit(),
    process: root,
    checkActive: checks.endpoint ?? (() => {}),
    policy,
  });
  const authority = must(
    claimTerminalAuthority({
      identity: display.identity,
      process: root,
      checkActive: checks.authority ?? (() => {}),
      policy,
    }),
  );
  const editor = must(authority.createGroup({ initialMode: "raw" }));
  const editorMember = must(authority.admitExisting({ group: editor, pid: root.pid }));
  const editorLease = must(authority.acquire({ group: editor, expected: null }));
  const descriptors = new DescriptorTable(),
    messages: WorkerProcessMessage[] = [];
  const codec = {
    export() {
      throw new Error("unexpected export");
    },
    import() {
      throw new Error("unexpected import");
    },
    discard() {},
  };
  const client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec,
    postMessage: (message) => messages.push(message),
  });
  function spawn(): WorkerProcessTransport {
    const pid = client.spawn(root.pid, {
      executable: "fixture",
      argv: [],
      env: {},
      cwd: "/",
      job: 0,
      fds: [],
    });
    const message = messages.find(
      (item) => item.operation === "spawn" && item.transport.pid === pid,
    );
    if (!message) throw new Error(`spawn failed ${pid}`);
    return message.transport;
  }
  function input(tokens: readonly number[]) {
    return display.input(() => {
      for (const token of tokens) {
        cells[4 + (cells[1]! % 128)] = token;
        cells[1]!++;
      }
      return tokens.length;
    });
  }
  function attach(process: WorkerProcessTransport, context: TerminalContext = display.inherit()) {
    return attachTerminal({ context: structuredClone(context), process, checkActive() {}, policy });
  }
  function cleanup() {
    attachment.dispose();
    display.close("disposed");
    descriptors.dispose();
  }
  return {
    root,
    buffer,
    cells,
    policy,
    display,
    attachment,
    authority,
    editor,
    editorMember,
    editorLease,
    descriptors,
    codec,
    client,
    spawn,
    input,
    attach,
    cleanup,
  };
}

test("shared mode, arbitrary different-job members, preserved queue, stale grants, background AGAIN and pipe controls", () => {
  const f = fixture();
  const first = f.spawn(),
    second = f.spawn(),
    background = f.spawn();
  const a = f.attach(first),
    b = f.attach(second),
    bg = f.attach(background);
  try {
    expect(workerProcessState(first).job).not.toBe(workerProcessState(second).job);
    const group = must(f.authority.createGroup({ initialMode: "cooked" }));
    const initial = must(f.authority.transfer({ from: f.editorLease, to: group }));
    must(f.authority.admitExisting({ group, pid: first.pid }));
    f.input([66, 0, 67]);
    const latest = must(f.authority.admitExisting({ group, pid: second.pid })).lease!;
    const one = a.resolve(0),
      two = b.resolve(0),
      backgroundInput = bg.resolve(0);
    const controls = terminalControls(one)!;
    const observed = must(controls.snapshot());
    must(controls.setMode({ expected: observed.selection, mode: "raw" }));
    expect(must(terminalControls(two)!.snapshot()).mode).toBe("raw");
    expect(
      f.display.input((turn) => {
        expect(turn.mode).toBe("raw");
        return 0;
      }).kind,
    ).toBe("ok");
    expect(backgroundInput.tryRead!([new Uint8Array(2)])).toBe(-6);
    expect(backgroundInput.readiness().hangup).toBe(false);
    const bytes = new Uint8Array(2);
    expect(one.tryRead!([bytes])).toBe(1);
    expect(bytes[0]).toBe(65);
    expect(two.tryRead!([new Uint8Array(0)])).toBe(0);
    expect(two.readiness().readable).toBe(true);
    expect(two.tryRead!([bytes])).toBe(0);
    expect(one.tryRead!([bytes])).toBe(1);
    expect(bytes[0]).toBe(66);
    expect(one.tryRead!([bytes])).toBe(-6);
    f.input([4]);
    expect(two.tryRead!([bytes])).toBe(1);
    expect(bytes[0]).toBe(3);
    expect(signalPending(workerProcessState(second).signals)).toBe(false);
    expect(f.authority.release({ lease: initial, restore: f.editor })).toEqual({
      kind: "error",
      code: "STALE",
    });
    const restored = must(f.authority.release({ lease: latest, restore: f.editor }));
    expect(restored).not.toBeNull();
    expect(must(f.display.snapshot()).mode).toBe("raw");
    expect(controls.setMode({ expected: observed.selection, mode: "cooked" })).toEqual({
      kind: "error",
      code: "DENIED",
    });
    expect(f.authority.release({ lease: latest, restore: null })).toEqual({
      kind: "error",
      code: "STALE",
    });
    const pipe = new PipeController({ capacity: 32, relay: "manual" });
    const reader = pipe.retain(1, "read"),
      writer = pipe.retain(1, "write");
    try {
      expect(terminalControls(reader)).toBeUndefined();
      expect(writer.write([new Uint8Array([3, 4])])).toBe(2);
      expect(reader.read([bytes])).toBe(2);
      expect(Array.from(bytes)).toEqual([3, 4]);
    } finally {
      reader.close?.();
      writer.close?.();
      pipe.dispose();
    }
  } finally {
    a.dispose();
    b.dispose();
    bg.dispose();
    f.cleanup();
  }
});

test("planned binding validates parent, canceled tickets and reused directory incarnations", () => {
  const f = fixture();
  try {
    const group = must(f.authority.createGroup({ initialMode: "cooked" }));
    must(f.authority.startBackground(group));
    const plan = must(f.authority.planMember({ group, parent: f.editorMember.member }));
    expect(f.authority.bindMember({ planned: plan.member, pid: 99999 })).toEqual({
      kind: "error",
      code: "PROCESS_GONE",
    });
    must(f.authority.cancelPlan(plan.member));
    must(f.authority.cancelPlan(plan.member));
    const child = f.spawn();
    expect(f.authority.bindMember({ planned: plan.member, pid: child.pid })).toEqual({
      kind: "error",
      code: "CANCELED",
    });
    const next = must(f.authority.planMember({ group, parent: f.editorMember.member }));
    must(f.authority.bindMember({ planned: next.member, pid: child.pid }));
    must(f.authority.bindMember({ planned: next.member, pid: child.pid }));
    expect(f.authority.bindMember({ planned: next.member, pid: f.spawn().pid })).toEqual({
      kind: "error",
      code: "INVALID",
    });
    const attached = f.attach(child, next.context),
      stream = attached.resolve(0);
    expect(attached.ready()).toEqual({ kind: "ok", value: undefined });
    expect(stream.tryRead!([new Uint8Array(1)])).toBe(-6);
    claimOutcome(workerProcessState(child).signals.outcome, { kind: "exited", code: 0 });
    confirmDirectoryProcess(child);
    collectDirectoryProcess(child);
    const replacement = f.spawn();
    expect(replacement.slot).toBe(child.slot);
    expect(stream.tryRead!([new Uint8Array(1)])).toBe(-8);
    expect(terminalControls(stream)!.snapshot()).toEqual({ kind: "error", code: "PROCESS_GONE" });
    attached.dispose();
    must(f.authority.retireGroup({ group, reason: "start-failed" }));
    expect(f.authority.bindMember({ planned: next.member, pid: replacement.pid }).kind).toBe(
      "error",
    );
  } finally {
    f.cleanup();
  }
});

test("policy failure and expired turns fail only the affected session closed", () => {
  let failing = false;
  const f = fixture((buffer) => {
    const base = tinyPolicy(buffer);
    return {
      ...base,
      transition(turn, change) {
        if (!failing) return base.transition(turn, change);
        new Int32Array(buffer)[2] = 17;
        return { kind: "error", code: "AGAIN" };
      },
    };
  });
  const other = fixture();
  try {
    let saved: TerminalTurn | undefined;
    must(
      f.display.input((turn) => {
        saved = turn;
        return 0;
      }),
    );
    expect(() => saved!.mode).toThrow("expired");
    const controls = terminalControls(f.attachment.resolve(0))!;
    failing = true;
    expect(
      controls.setMode({ expected: must(controls.snapshot()).selection, mode: "cooked" }),
    ).toEqual({ kind: "error", code: "CLOSED" });
    expect(f.cells[2]).toBe(17);
    expect(f.display.snapshot()).toEqual({ kind: "error", code: "CLOSED" });
    expect(other.display.snapshot().kind).toBe("ok");
  } finally {
    f.cleanup();
    other.cleanup();
  }
});

test("aliases, rollback, controls guard, wrapper/subscription bounds and independent close", async () => {
  const f = fixture(),
    table = new DescriptorTable();
  let active = true;
  const a = attachTerminal({
    context: f.display.inherit(),
    process: f.root,
    policy: f.policy,
    checkActive() {
      if (!active) throw new Error("revoked");
    },
  });
  const codec = createRuntimeTerminalCodec({
    fallback: f.codec,
    resolveTerminal: (target) => a.resolve(target),
    checkActive() {
      if (!active) throw new Error("revoked");
    },
  });
  try {
    const d = codec.import({ kind: "web-terminal", target: 0 }, f.root.pid);
    const fd = table.add(d, { rightsBase: 0n, rightsInheriting: 0n }),
      alias = table.dup(fd);
    const controls = terminalControls(table.get(alias)!.resource)!;
    expect(controls).toBeDefined();
    table.close(fd);
    expect(controls.snapshot().kind).toBe("ok");
    expect(codec.export(table.get(alias)!, 4)).toEqual({ kind: "web-terminal", target: 0 });
    const cursor = must(controls.subscribeGeometry());
    must(cursor.poll());
    const waiting = cursor.wait();
    table.close(alias);
    expect(await waiting).toEqual({ kind: "error", code: "CANCELED" });
    const stream = a.resolve(0),
      more = terminalControls(stream)!;
    const cursors = Array.from({ length: 64 }, () => must(more.subscribeGeometry()));
    expect(more.subscribeGeometry()).toEqual({ kind: "error", code: "CAPACITY" });
    for (const item of cursors) item.dispose();
    const wrappers = Array.from({ length: 255 }, () => a.resolve(1));
    expect(() => a.resolve(1)).toThrow("capacity");
    for (const item of wrappers) item.close?.();
    active = false;
    expect(() => more.snapshot()).toThrow("revoked");
    a.dispose();
    expect(f.display.snapshot().kind).toBe("ok");
  } finally {
    table.dispose();
    a.dispose();
    f.cleanup();
  }
});

test("geometry revision and real handled SIGWINCH interrupt runtime poll without input readiness", async () => {
  const f = fixture(),
    table = new DescriptorTable();
  const stream = f.attachment.resolve(0),
    control = terminalControls(stream)!;
  const state = workerProcessState(f.root),
    cursor = must(control.subscribeGeometry());
  try {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const fd = table.open(stream, (1n << 29n) - 1n, 0n);
    const view = new DataView(memory.buffer);
    view.setUint32(128, 0, true);
    view.setUint32(132, fd, true);
    let now = 0,
      waits = 0;
    const abi = new ProcessABI({
      memory,
      descriptors: table,
      fs: new MemFS(),
      pid: f.root.pid,
      service: f.client,
      signals: state.signals,
      wake: state.wake,
      now: () => now,
      wait() {
        waits++;
        now += 10;
        if (waits === 1) f.display.outputDrained();
        if (waits === 2) must(f.display.resize({ columns: 103, rows: 31 }));
      },
    });
    expect(abi.imports.signal!(28, 2)).toBe(0);
    expect(must(cursor.poll())).toEqual({ columns: 120, rows: 24, revision: 1 });
    expect(abi.imports.poll!(128, 1, 100, 256)).toBe(0);
    expect(waits).toBe(2);
    expect(signalPending(state.signals)).toBe(true);
    expect(stream.readiness().readable).toBe(false);
    expect(stream.read([new Uint8Array(1)])).toBe(-27);
    takeSignal(state.signals.signalState, state.signals.interrupt);
    expect(must(cursor.poll())).toEqual({ columns: 103, rows: 31, revision: 2 });
    expect(must(cursor.poll())).toBeNull();
    expect(must(f.display.resize({ columns: 103, rows: 31 })).revision).toBe(2);
    const wait = cursor.wait();
    expect(await cursor.wait()).toEqual({ kind: "error", code: "AGAIN" });
    cursor.dispose();
    expect(await wait).toEqual({ kind: "error", code: "CANCELED" });
  } finally {
    cursor.dispose();
    table.dispose();
    f.cleanup();
  }
});

test("gate contention never implies death, close remains available with an abandoned gate", () => {
  const f = fixture();
  try {
    const raw = f.display.identity as unknown as { buffer: SharedArrayBuffer };
    const gate = new BigInt64Array(raw.buffer, 64, 1);
    Atomics.store(gate, 0, 999n);
    expect(f.display.snapshot()).toEqual({ kind: "error", code: "AGAIN" });
    f.display.close("failed");
    expect(f.display.snapshot()).toEqual({ kind: "error", code: "CLOSED" });
    expect(Atomics.load(gate, 0)).toBe(999n);
  } finally {
    f.cleanup();
  }
});

const workerModule = new URL("../browser/terminal-session.ts", import.meta.url).href;
function workerSource(): string {
  return `const {parentPort,workerData}=require('node:worker_threads');
(async()=>{ const {attachTerminal,terminalControls}=await import(${JSON.stringify(workerModule)});
 const readChunk=(${readChunk.toString()}); const policy=(${tinyPolicy.toString()})(workerData.buffer);
 const cells=new Int32Array(workerData.buffer), audit=new Int32Array(workerData.audit);
 const read=policy.tryRead;policy.tryRead=(turn,chunks)=>{const count=read(turn,chunks);if(count>=0){const at=audit[0]++;audit[1+at]=count===0?0:chunks[0][0]+1;}return count;};
 function readOne(s,chunk,cells){let count;for(let attempt=0;attempt<20;attempt++){count=s.tryRead([chunk]);if(count!==-6)return count;Atomics.wait(cells,3,0,1);}return count;}
 const a=attachTerminal({context:workerData.context,process:workerData.process,checkActive(){},policy});
 try{const s=a.resolve(0); parentPort.postMessage({phase:'attached'});
 const result=a.ready(); parentPort.postMessage({phase:'ready',result});
 if(result.kind!=='ok')return;
 while(Atomics.load(cells,2)===0)Atomics.wait(cells,2,0,10);
 const c=terminalControls(s);let snapshot;do{snapshot=c.snapshot();if(snapshot.code==='AGAIN')Atomics.wait(cells,3,0,1);}while(snapshot.code==='AGAIN');
 const zero=s.tryRead([new Uint8Array(0)]), results=[];
 for(let i=0;i<3;i++){const chunk=new Uint8Array(1);const count=readOne(s,chunk,cells);results.push({count,byte:chunk[0]});}
 parentPort.postMessage({phase:'mode',snapshot,zero,results});
 }finally{a.dispose();parentPort.close();}})().catch(error=>{parentPort.postMessage({error:String(error)});parentPort.close()});`;
}
function startModeWorker(
  process: WorkerProcessTransport,
  context: TerminalContext,
  buffer: SharedArrayBuffer,
  audit: SharedArrayBuffer,
  messages: unknown[],
) {
  const worker = new Worker(workerSource(), {
    eval: true,
    workerData: { process, context, buffer, audit },
  });
  worker.on("message", (data) => messages.push(data));
  const exited = new Promise<number>((resolve, reject) => {
    worker.once("exit", resolve);
    worker.once("error", reject);
  });
  return { worker, exited };
}
async function retryGate<T>(operation: () => TerminalResult<T>): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = operation();
    if (result.kind === "ok") return result.value;
    if (result.code !== "AGAIN") return must(result);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("caller gate-contention budget exhausted");
}

test("two real workers in different jobs share mode and consume one ordered byte/EOF queue", async () => {
  const f = fixture(),
    workers: Worker[] = [],
    auditBuffer = new SharedArrayBuffer(32);
  try {
    const group = must(f.authority.createGroup({ initialMode: "cooked" }));
    must(f.authority.transfer({ from: f.editorLease, to: group }));
    const first = must(f.authority.planMember({ group, parent: f.editorMember.member }));
    const second = must(f.authority.planMember({ group, parent: f.editorMember.member }));
    const later = must(f.authority.planMember({ group, parent: f.editorMember.member }));
    const child = f.spawn(),
      sibling = f.spawn();
    expect(workerProcessState(child).job).not.toBe(workerProcessState(sibling).job);
    const messages: unknown[][] = [[], []];
    const started = [child, sibling].map((process, index) =>
      startModeWorker(
        process,
        index === 0 ? first.context : second.context,
        f.buffer,
        auditBuffer,
        messages[index]!,
      ),
    );
    workers.push(...started.map((item) => item.worker));
    const exited = started.map((item) => item.exited);
    const binding = await retryGate(() =>
      f.authority.bindMember({ planned: first.member, pid: child.pid }),
    );
    const latest = await retryGate(() =>
      f.authority.bindMember({ planned: second.member, pid: sibling.pid }),
    );
    const siblingView = f.attach(sibling, latest.context);
    const controls = terminalControls(siblingView.resolve(0))!;
    const observed = await retryGate(() => controls.snapshot());
    await retryGate(() => controls.setMode({ expected: observed.selection, mode: "raw" }));
    await retryGate(() => f.input([4, 0, 5]));
    Atomics.store(f.cells, 2, 1);
    Atomics.notify(f.cells, 2);
    expect(await Promise.all(exited)).toEqual([0, 0]);
    for (const list of messages) {
      expect(list).toContainEqual({ phase: "ready", result: { kind: "ok", value: undefined } });
      expect(
        list.find(
          (item) =>
            typeof item === "object" && item !== null && "phase" in item && item.phase === "mode",
        ),
      ).toMatchObject({ snapshot: { kind: "ok", value: { mode: "raw" } }, zero: 0 });
    }
    expect(Array.from(new Int32Array(auditBuffer).subarray(0, 4))).toEqual([3, 4, 0, 5]);
    expect(signalPending(workerProcessState(child).signals)).toBe(false);
    expect(signalPending(workerProcessState(sibling).signals)).toBe(false);
    must(f.authority.cancelPlan(later.member));
    expect(f.authority.release({ lease: binding.lease!, restore: f.editor })).toEqual({
      kind: "error",
      code: "STALE",
    });
    must(f.authority.release({ lease: latest.lease!, restore: f.editor }));
    siblingView.dispose();
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    f.cleanup();
  }
});

test("fixed control bounds reclaim canceled rows with new generations and never wrap", () => {
  const f = fixture();
  try {
    const raw = f.display.identity as unknown as { buffer: SharedArrayBuffer };
    expect(raw.buffer.byteLength).toBe(TERMINAL_SESSION_LIMITS.controlBytes);
    const groups = Array.from({ length: 63 }, () =>
      must(f.authority.createGroup({ initialMode: "cooked" })),
    );
    expect(f.authority.createGroup({ initialMode: "raw" })).toEqual({
      kind: "error",
      code: "CAPACITY",
    });
    must(f.authority.retireGroup({ group: groups[0]!, reason: "completed" }));
    const next = must(f.authority.createGroup({ initialMode: "raw" }));
    expect(f.authority.startBackground(groups[0]!)).toEqual({ kind: "error", code: "STALE" });
    const plans = Array.from({ length: 255 }, () =>
      must(f.authority.planMember({ group: next, parent: f.editorMember.member })),
    );
    expect(f.authority.planMember({ group: next, parent: f.editorMember.member })).toEqual({
      kind: "error",
      code: "CAPACITY",
    });
    must(f.authority.cancelPlan(plans[0]!.member));
    const replacement = must(
      f.authority.planMember({ group: next, parent: f.editorMember.member }),
    );
    expect(f.authority.cancelPlan(plans[0]!.member)).toEqual({ kind: "error", code: "STALE" });
    must(f.authority.cancelPlan(replacement.member));
    const words = new Int32Array(raw.buffer);
    Atomics.store(words, 14, TERMINAL_SESSION_LIMITS.maximumGeneration);
    expect(f.display.resize({ columns: 121, rows: 24 })).toEqual({
      kind: "error",
      code: "EXHAUSTED",
    });
    expect(f.display.snapshot()).toEqual({ kind: "error", code: "CLOSED" });
  } finally {
    f.cleanup();
  }
});

test("root-only authority and nontransferable handles do not clone authority with identity", () => {
  const f = fixture();
  try {
    const child = f.spawn();
    expect(
      claimTerminalAuthority({
        identity: structuredClone(f.display.identity),
        process: child,
        checkActive() {},
        policy: f.policy,
      }),
    ).toEqual({ kind: "error", code: "DENIED" });
    expect(
      claimTerminalAuthority({
        identity: structuredClone(f.display.identity),
        process: f.root,
        checkActive() {},
        policy: f.policy,
      }),
    ).toEqual({ kind: "error", code: "DENIED" });
    expect(() => structuredClone(f.editor)).toThrow();
    expect(() => structuredClone(f.editorLease)).toThrow();
    expect(() =>
      attachTerminal({ context: {}, process: child, policy: f.policy, checkActive() {} }),
    ).toThrow(TypeError);
    const foreign = createWorkerProcessTransport();
    expect(() =>
      attachTerminal({
        context: f.display.inherit(),
        process: foreign,
        policy: f.policy,
        checkActive() {},
      }),
    ).toThrow("another process directory");
    let armed = false;
    const attached = attachTerminal({
      context: f.display.inherit(),
      process: f.root,
      policy: f.policy,
      checkActive() {
        if (!armed) throw Error("guard unarmed");
      },
    });
    const stream = attached.resolve(0); // Allocation before bootstrap setup is allowed.
    expect(() => terminalControls(stream)!.snapshot()).toThrow("unarmed");
    armed = true;
    expect(attached.ready().kind).toBe("ok");
    attached.dispose();
  } finally {
    f.cleanup();
  }
});

test("installed inherited root stdio follows explicit admission without replacing its view", () => {
  const root = createWorkerProcessTransport({ capacity: 64 });
  const table = new DescriptorTable();
  const buffer = new SharedArrayBuffer(132 * 4);
  const cells = new Int32Array(buffer);
  const policy = tinyPolicy(buffer);
  const display = createTerminalSession({ controller: root, geometry: { columns: 120, rows: 24 } });
  let armed = false;
  const checkActive = () => {
    if (!armed) throw new Error("guard unarmed");
  };
  const attachment = attachTerminal({
    context: display.inherit(),
    process: root,
    policy,
    checkActive,
  });
  const codec = createRuntimeTerminalCodec({
    fallback: {
      export() {
        throw new Error("unexpected export");
      },
      import() {
        throw new Error("unexpected import");
      },
      discard() {},
    },
    resolveTerminal: (target) => attachment.resolve(target),
  });
  root.resources = [{ kind: "web-terminal", target: 0 }];
  root.bindings = [{ fd: 0, reference: 0, rightsBase: 0n, rightsInheriting: 0n }];
  const client = new WorkerProcessClient({
    transport: root,
    descriptors: table,
    codec,
    postMessage() {},
  });
  try {
    client.installBindings();
    const installed = table.get(0)!.resource;
    if (installed.kind !== "terminal") throw new Error("missing terminal");
    expect(() => installed.tryRead!([new Uint8Array(1)])).toThrow("unarmed");
    armed = true;
    const authority = must(
      claimTerminalAuthority({ identity: display.identity, process: root, checkActive, policy }),
    );
    const group = must(authority.createGroup({ initialMode: "raw" }));
    must(authority.acquire({ group, expected: null }));
    must(
      display.input(() => {
        cells[4] = 66;
        cells[1] = 1;
        return 1;
      }),
    );
    expect(installed.tryRead!([new Uint8Array(1)])).toBe(-6);
    expect(cells[0]).toBe(0);
    const admitted = must(authority.admitExisting({ group, pid: root.pid }));
    const admittedView = attachTerminal({
      context: admitted.context,
      process: root,
      policy,
      checkActive,
    });
    try {
      expect(must(terminalControls(admittedView.resolve(0))!.snapshot()).selection).not.toBeNull();
      expect(table.get(0)!.resource).toBe(installed);
      const output = new Uint8Array(1);
      expect(installed.tryRead!([output])).toBe(1);
      expect(output[0]).toBe(65);
      must(authority.removeMember(admitted.member));
      must(
        display.input(() => {
          cells[5] = 67;
          cells[1] = 2;
          return 1;
        }),
      );
      expect(installed.tryRead!([output])).toBe(-6);
      expect(cells[0]).toBe(1);
    } finally {
      admittedView.dispose();
    }
  } finally {
    table.dispose();
    attachment.dispose();
    display.close("disposed");
  }
});

test("one resolved endpoint import is rolled back without closing other aliases or the session", () => {
  const f = fixture(),
    table = new DescriptorTable();
  const child = f.spawn();
  const attachment = f.attach(child);
  try {
    child.resources = [{ kind: "web-terminal", target: 0 }, { kind: "broken" }];
    child.bindings = [
      { fd: 0, reference: 0, rightsBase: 0n, rightsInheriting: 0n },
      { fd: 1, reference: 1, rightsBase: 0n, rightsInheriting: 0n },
    ];
    const resolved: Stream[] = [];
    const codec = createRuntimeTerminalCodec({
      fallback: f.codec,
      resolveTerminal(target) {
        const stream = attachment.resolve(target);
        resolved.push(stream);
        return stream;
      },
    });
    const client = new WorkerProcessClient({
      transport: child,
      descriptors: table,
      codec,
      postMessage() {},
    });
    expect(() => client.installBindings()).toThrow("unexpected import");
    expect(resolved).toHaveLength(1);
    expect(terminalControls(resolved[0])!.snapshot()).toEqual({ kind: "error", code: "CANCELED" });
    expect(table.get(0)).toBeUndefined();
    expect(f.display.snapshot().kind).toBe("ok");
    expect(terminalControls(attachment.resolve(0))!.snapshot().kind).toBe("ok");
  } finally {
    table.dispose();
    attachment.dispose();
    f.cleanup();
  }
});

function transitionFixture() {
  let fault = () => {};
  const f = fixture((buffer) => {
    const policy = tinyPolicy(buffer);
    return {
      ...policy,
      transition(turn, change) {
        fault();
        return policy.transition(turn, change);
      },
    };
  });
  return {
    ...f,
    fault(action: () => void) {
      fault = action;
    },
  };
}
for (const operation of ["bind", "admit", "select"] as const)
  test(`participant death during ${operation} policy cannot publish authority`, () => {
    const f = transitionFixture();
    try {
      const child = f.spawn(),
        group = must(f.authority.createGroup({ initialMode: "cooked" }));
      const plan = must(f.authority.planMember({ group, parent: f.editorMember.member }));
      if (operation !== "select") must(f.authority.transfer({ from: f.editorLease, to: group }));
      if (operation === "select") must(f.authority.admitExisting({ group, pid: child.pid }));
      f.fault(() => {
        claimOutcome(workerProcessState(child).signals.outcome, { kind: "exited", code: 0 });
      });
      const result =
        operation === "bind"
          ? f.authority.bindMember({ planned: plan.member, pid: child.pid })
          : operation === "admit"
            ? f.authority.admitExisting({ group, pid: child.pid })
            : f.authority.transfer({ from: f.editorLease, to: group });
      expect(result.kind === "error" ? result.code : "OK").toBe("CLOSED");
      expect(f.display.snapshot()).toEqual({ kind: "error", code: "CLOSED" });
    } finally {
      f.cleanup();
    }
  });

test("one incarnation cannot bind two plans in the same group", () => {
  const f = fixture();
  try {
    const child = f.spawn(),
      group = must(f.authority.createGroup({ initialMode: "cooked" }));
    const a = must(f.authority.planMember({ group, parent: f.editorMember.member }));
    const b = must(f.authority.planMember({ group, parent: f.editorMember.member }));
    must(f.authority.bindMember({ planned: a.member, pid: child.pid }));
    const duplicate = f.authority.bindMember({ planned: b.member, pid: child.pid });
    expect(duplicate.kind === "error" ? duplicate.code : "OK").toBe("INVALID");
    must(f.authority.cancelPlan(b.member));
  } finally {
    f.cleanup();
  }
});

test("geometry wait retries contention and settles on real process or session lifecycle", async () => {
  const f = fixture(),
    child = f.spawn(),
    a = f.attach(child);
  const raw = f.display.identity as unknown as { buffer: SharedArrayBuffer };
  const gate = new BigInt64Array(raw.buffer, 64, 1);
  const cursor = must(terminalControls(a.resolve(0))!.subscribeGeometry());
  try {
    must(cursor.poll());
    Atomics.store(gate, 0, 999n);
    let settled = false;
    const waiting = cursor.wait().then((result) => {
      settled = true;
      return result;
    });
    await Bun.sleep(20);
    expect(settled).toBe(false);
    Atomics.store(gate, 0, 0n);
    must(f.display.resize({ columns: 103, rows: 31 }));
    expect(await waiting).toEqual({ kind: "ok", value: { columns: 103, rows: 31, revision: 2 } });
    const revoked = cursor.wait();
    claimOutcome(workerProcessState(child).signals.outcome, { kind: "exited", code: 0 });
    expect(await revoked).toEqual({ kind: "error", code: "PROCESS_GONE" });
    const live = must(terminalControls(f.attachment.resolve(0))!.subscribeGeometry());
    must(live.poll());
    const closing = live.wait();
    f.display.close("disposed");
    expect(await closing).toEqual({ kind: "error", code: "CLOSED" });
    live.dispose();
  } finally {
    Atomics.store(gate, 0, 0n);
    cursor.dispose();
    a.dispose();
    f.cleanup();
  }
});

test("removing final selected member replaces its lease and restores editor exactly once", () => {
  const f = fixture();
  try {
    const child = f.spawn(),
      group = must(f.authority.createGroup({ initialMode: "cooked" }));
    const selected = must(f.authority.transfer({ from: f.editorLease, to: group }));
    const admitted = must(f.authority.admitExisting({ group, pid: child.pid }));
    const removed = must(f.authority.removeMember(admitted.member));
    expect(f.authority.release({ lease: selected, restore: f.editor })).toEqual({
      kind: "error",
      code: "STALE",
    });
    expect(f.authority.release({ lease: admitted.lease!, restore: f.editor })).toEqual({
      kind: "error",
      code: "STALE",
    });
    must(f.authority.release({ lease: removed.lease!, restore: f.editor }));
    expect(f.authority.release({ lease: removed.lease!, restore: f.editor })).toEqual({
      kind: "error",
      code: "STALE",
    });
    expect(must(f.display.snapshot()).mode).toBe("raw");
    must(f.authority.retireGroup({ group, reason: "completed" }));
    must(f.authority.retireGroup({ group, reason: "completed" }));
  } finally {
    f.cleanup();
  }
});

for (const word of [9, 11])
  test(`shared control counter ${word} exhaustion closes without generation wrap`, () => {
    const f = fixture();
    try {
      const raw = f.display.identity as unknown as { buffer: SharedArrayBuffer };
      if (word === 9) must(f.authority.release({ lease: f.editorLease, restore: null }));
      Atomics.store(new Int32Array(raw.buffer), word, TERMINAL_SESSION_LIMITS.maximumGeneration);
      const group = must(f.authority.createGroup({ initialMode: "cooked" }));
      const result =
        word === 9
          ? f.authority.acquire({ group, expected: null })
          : f.authority.transfer({ from: f.editorLease, to: group });
      expect(result).toEqual({
        kind: "error",
        code: "EXHAUSTED",
      });
      expect(f.display.snapshot()).toEqual({ kind: "error", code: "CLOSED" });
    } finally {
      f.cleanup();
    }
  });

test("process-only output revocation does not close session, policy exception does", () => {
  const f = fixture(),
    other = fixture();
  let active = true;
  const a = attachTerminal({
    context: f.display.inherit(),
    process: f.root,
    checkActive() {
      if (!active) throw Error("process revoked");
    },
    policy: {
      ...f.policy,
      tryWrite() {
        active = false;
        return 1;
      },
    },
  });
  const throwing = attachTerminal({
    context: other.display.inherit(),
    process: other.root,
    checkActive() {},
    policy: {
      ...other.policy,
      tryWrite() {
        throw Error("policy failed");
      },
    },
  });
  try {
    expect(() => a.resolve(1).tryWrite!([new Uint8Array(1)])).toThrow("process revoked");
    expect(f.display.snapshot().kind).toBe("ok");
    expect(() => throwing.resolve(1).tryWrite!([new Uint8Array(1)])).toThrow("policy failed");
    expect(other.display.snapshot()).toEqual({ kind: "error", code: "CLOSED" });
  } finally {
    a.dispose();
    throwing.dispose();
    f.cleanup();
    other.cleanup();
  }
});

test("terminal private state never passes through guest-replaced host operations", () => {
  const f = fixture(),
    child = f.spawn();
  const raw = f.display.identity as unknown as { buffer: SharedArrayBuffer };
  let report: IntrinsicsReport | undefined;
  const observer = poisonProcessIntrinsics([raw.buffer, f.root.directory]);
  try {
    const group = must(f.authority.createGroup({ initialMode: "cooked" }));
    must(f.authority.transfer({ from: f.editorLease, to: group }));
    const admitted = must(f.authority.admitExisting({ group, pid: child.pid }));
    const attached = f.attach(child, admitted.context),
      stream = attached.resolve(0);
    const controls = terminalControls(stream)!;
    must(controls.setMode({ expected: must(controls.snapshot()).selection, mode: "raw" }));
    const cursor = must(controls.subscribeGeometry());
    must(cursor.poll());
    must(f.display.resize({ columns: 102, rows: 30 }));
    must(cursor.poll());
    cursor.dispose();
    stream.close?.();
    attached.dispose();
    must(f.authority.release({ lease: admitted.lease!, restore: f.editor }));
    must(f.authority.retireGroup({ group, reason: "completed" }));
  } finally {
    report = observer.restore();
    f.cleanup();
  }
  expect(report.leaks).toEqual([]);
  expect(report.canaries).toContain("Atomics.load");
});

test("display callback counts distinguish accepted prefix from zero-mutation AGAIN", () => {
  const f = fixture();
  try {
    const packet = [66, 67, 68];
    const accepted = must(f.input(packet.slice(0, 2)));
    expect(accepted).toBe(2);
    expect(packet.slice(accepted)).toEqual([68]);
    expect(Array.from(f.cells.slice(4, 7))).toEqual([66, 67, 0]);
    const before = Array.from(f.cells);
    expect(f.display.input(() => -6)).toEqual({ kind: "error", code: "AGAIN" });
    expect(Array.from(f.cells)).toEqual(before);
    const raw = f.display.identity as unknown as { buffer: SharedArrayBuffer };
    const gate = new BigInt64Array(raw.buffer, 64, 1);
    Atomics.store(gate, 0, 999n);
    let called = false;
    expect(
      f.display.input(() => {
        called = true;
        return 1;
      }),
    ).toEqual({ kind: "error", code: "AGAIN" });
    expect(called).toBe(false);
    expect(Array.from(f.cells)).toEqual(before);
    Atomics.store(gate, 0, 0n);
    expect(f.display.input(() => 4096)).toEqual({ kind: "ok", value: 4096 });
    expect(f.display.input(() => -8)).toEqual({ kind: "error", code: "INVALID" });
    expect(f.display.snapshot()).toEqual({ kind: "error", code: "CLOSED" });
  } finally {
    f.cleanup();
  }
});

test("page close never steals the gate from an actually terminated worker", async () => {
  const f = fixture(),
    other = fixture(),
    child = f.spawn();
  let worker: Worker | undefined;
  const raw = f.display.identity as unknown as { buffer: SharedArrayBuffer };
  const gate = new BigInt64Array(raw.buffer, 64, 1),
    hold = new SharedArrayBuffer(4);
  try {
    const group = must(f.authority.createGroup({ initialMode: "raw" }));
    must(f.authority.transfer({ from: f.editorLease, to: group }));
    const admitted = must(f.authority.admitExisting({ group, pid: child.pid }));
    worker = new Worker(
      `const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{const {attachTerminal}=await import(${JSON.stringify(workerModule)});
      const a=attachTerminal({context:workerData.context,process:workerData.process,checkActive(){},
      policy:{inputReadiness:()=>({readable:true,nbytes:1}),tryRead(){parentPort.postMessage('held');Atomics.wait(new Int32Array(workerData.hold),0,0);return -6;},transition:()=>({kind:'ok',value:undefined}),tryWrite:()=>0,outputReadiness:()=>({writable:true})}});
      try{a.ready();a.resolve(0).tryRead([new Uint8Array(1)]);}finally{a.dispose();parentPort.close();}})();`,
      { eval: true, workerData: { context: admitted.context, process: child, hold } },
    );
    const held = new Promise((resolve, reject) => {
      worker!.once("message", resolve);
      worker!.once("error", reject);
    });
    expect(await held).toBe("held");
    expect(Atomics.load(gate, 0)).toBe(BigInt(child.pid));
    await worker.terminate();
    claimOutcome(workerProcessState(child).signals.outcome, { kind: "exited", code: 1 });
    expect(f.display.snapshot()).toEqual({ kind: "error", code: "AGAIN" });
    f.display.close("failed");
    expect(f.display.snapshot()).toEqual({ kind: "error", code: "CLOSED" });
    expect(Atomics.load(gate, 0)).toBe(BigInt(child.pid));
    expect(other.display.snapshot().kind).toBe("ok");
  } finally {
    if (worker) await worker.terminate();
    f.cleanup();
    other.cleanup();
  }
});


function controlWords(display: ReturnType<typeof createTerminalSession>): Int32Array {
  const identity = display.identity as unknown as { buffer: SharedArrayBuffer };
  return new Int32Array(identity.buffer);
}
function expectClosedWithoutPublication(
  display: ReturnType<typeof createTerminalSession>,
  before: Int32Array,
) {
  expect(display.snapshot()).toEqual({ kind: "error", code: "CLOSED" });
  const after = controlWords(display).slice();
  expect(after[0]).toBe(1);
  after[0] = before[0]!;
  after[15] = before[15]!;
  expect(after).toEqual(before);
}
function transitionFixture() {
  let revoked = false;
  let action: TerminalPolicy["transition"] | undefined;
  const checkActive = () => {
    if (revoked) throw new Error("R29 admission revoked");
  };
  const f = fixture(
    (buffer) => {
      const policy = tinyPolicy(buffer);
      return {
        ...policy,
        transition: (turn, change) =>
          action ? action(turn, change) : policy.transition(turn, change),
      };
    },
    { authority: checkActive, endpoint: checkActive },
  );
  return {
    ...f,
    revoke() {
      revoked = true;
    },
    fault(next: TerminalPolicy["transition"]) {
      action = next;
    },
  };
}
type TransitionCase =
  | "mode"
  | "remove"
  | "release-null"
  | "restore"
  | "transfer"
  | "acquire"
  | "admit"
  | "bind";
function transitionOperation(f: ReturnType<typeof transitionFixture>, operation: TransitionCase) {
  const group = must(f.authority.createGroup({ initialMode: "cooked" }));
  const child = f.spawn();
  const controls = terminalControls(f.attachment.resolve(0))!;
  const expected = must(controls.snapshot()).selection;
  const planned = must(f.authority.planMember({ group: f.editor, parent: f.editorMember.member }));
  switch (operation) {
    case "mode":
      return () => controls.setMode({ expected, mode: "cooked" });
    case "remove":
      return () => f.authority.removeMember(f.editorMember.member);
    case "release-null":
      return () => f.authority.release({ lease: f.editorLease, restore: null });
    case "restore":
      return () => f.authority.release({ lease: f.editorLease, restore: group });
    case "transfer":
      return () => f.authority.transfer({ from: f.editorLease, to: group });
    case "acquire":
      must(f.authority.release({ lease: f.editorLease, restore: null }));
      return () => f.authority.acquire({ group, expected: null });
    case "admit":
      return () => f.authority.admitExisting({ group: f.editor, pid: child.pid });
    case "bind":
      return () => f.authority.bindMember({ planned: planned.member, pid: child.pid });
  }
}
const transitionCases: readonly TransitionCase[] = [
  "mode", "remove", "release-null", "restore", "transfer", "acquire", "admit", "bind",
];
for (const operation of transitionCases)
  test(`R29 post-policy ${operation} admission throws close before any control publication`, () => {
    const f = transitionFixture();
    const run = transitionOperation(f, operation);
    const before = controlWords(f.display).slice();
    f.fault(() => {
      f.cells[130]!++;
      f.revoke();
      return { kind: "ok", value: undefined };
    });
    try {
      expect(run).toThrow("R29 admission revoked");
      expect(f.cells[130]).toBe(1);
      expectClosedWithoutPublication(f.display, before);
    } finally {
      f.cleanup();
    }
  });

test("R29 post-policy endpoint disposal fails closed without publishing mode", () => {
  const f = transitionFixture();
  const run = transitionOperation(f, "mode");
  const before = controlWords(f.display).slice();
  f.fault(() => {
    f.cells[130]!++;
    f.attachment.dispose();
    return { kind: "ok", value: undefined };
  });
  try {
    expect(run()).toEqual({ kind: "error", code: "CANCELED" });
    expect(f.cells[130]).toBe(1);
    expectClosedWithoutPublication(f.display, before);
  } finally {
    f.cleanup();
  }
});

for (const operation of transitionCases)
  test(`R29 ${operation} gate contention has zero control and policy mutation`, () => {
    const f = transitionFixture();
    const run = transitionOperation(f, operation);
    const words = controlWords(f.display);
    const gate = new BigInt64Array(words.buffer, 64, 1);
    Atomics.store(gate, 0, 999n);
    const before = words.slice();
    f.fault(() => {
      throw new Error("policy must not run under contention");
    });
    try {
      expect(run()).toEqual({ kind: "error", code: "AGAIN" });
      expect(words).toEqual(before);
      expect(f.cells[130]).toBe(0);
    } finally {
      Atomics.store(gate, 0, 0n);
      f.cleanup();
    }
  });

test("R29 throwing transition discriminant is guarded after policy mutation", () => {
  const f = transitionFixture();
  const run = transitionOperation(f, "mode");
  const before = controlWords(f.display).slice();
  f.fault(() => {
    f.cells[130]!++;
    return {
      get kind(): "ok" {
        throw new Error("R29 result accessor");
      },
      value: undefined,
    };
  });
  try {
    expect(run).toThrow("R29 result accessor");
    expect(f.cells[130]).toBe(1);
    expectClosedWithoutPublication(f.display, before);
    expect(new BigInt64Array(controlWords(f.display).buffer, 64, 1)[0]).toBe(0n);
  } finally {
    f.cleanup();
  }
});

test("R29 initial geometry object and dimensions are each captured once", () => {
  const root = createWorkerProcessTransport({ capacity: 4 });
  let objects = 0, columns = 0, rows = 0;
  const display = createTerminalSession({
    controller: root,
    get geometry() {
      objects++;
      return {
        get columns() { return ++columns === 1 ? 120 : 0; },
        get rows() { return ++rows === 1 ? 24 : 0; },
      };
    },
  });
  try {
    expect(must(display.snapshot()).geometry).toEqual({ columns: 120, rows: 24, revision: 1 });
    expect([objects, columns, rows]).toEqual([1, 1, 1]);
  } finally {
    display.close("disposed");
  }
});

test("R29 resize captures changing dimensions once before gate entry", () => {
  const f = fixture();
  let columns = 0, rows = 0;
  try {
    const result = f.display.resize({
      get columns() { return ++columns === 1 ? 103 : 0; },
      get rows() { return ++rows === 1 ? 31 : 0; },
    });
    expect(result).toEqual({ kind: "ok", value: { columns: 103, rows: 31, revision: 2 } });
    expect(must(f.display.snapshot()).geometry).toEqual({ columns: 103, rows: 31, revision: 2 });
    expect([columns, rows]).toEqual([1, 1]);
  } finally {
    f.cleanup();
  }
});

for (const dimension of ["columns", "rows"] as const)
  test(`R29 throwing ${dimension} getter leaves resize control block unchanged`, () => {
    const f = fixture();
    const before = controlWords(f.display).slice();
    const geometry = { columns: 103, rows: 31 };
    Object.defineProperty(geometry, dimension, { get() { throw new Error("R29 geometry accessor"); } });
    try {
      expect(() => f.display.resize(geometry)).toThrow("R29 geometry accessor");
      expect(controlWords(f.display)).toEqual(before);
      expect(must(f.display.snapshot()).geometry).toEqual({ columns: 120, rows: 24, revision: 1 });
    } finally {
      f.cleanup();
    }
  });

test("R29 creation captures geometry before consulting root liveness", () => {
  const root = createWorkerProcessTransport({ capacity: 4 });
  const exitedGeometry = {
    get columns() {
      claimOutcome(workerProcessState(root).signals.outcome, { kind: "exited", code: 0 });
      return 120;
    },
    rows: 24,
  };
  expect(() => createTerminalSession({ controller: root, geometry: exitedGeometry })).toThrow(
    "terminal root is not live",
  );
});

test("R29 resize getter reentry observes precommit geometry with a free gate", () => {
  const f = fixture();
  const observed: TerminalResult<unknown>[] = [];
  const before = controlWords(f.display).slice();
  const geometry = {
    get columns() {
      observed.push(f.display.snapshot());
      expect(controlWords(f.display)).toEqual(before);
      return 103;
    },
    rows: 31,
  };
  try {
    must(f.display.resize(geometry));
    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual({ kind: "ok", value: {
      mode: "raw", modeRevision: 2,
      geometry: { columns: 120, rows: 24, revision: 1 }, selection: 1,
    } });
  } finally {
    f.cleanup();
  }
});

test("R29 invalid resize preserves every control word", () => {
  const f = fixture();
  const before = controlWords(f.display).slice();
  try {
    expect(f.display.resize({ columns: 0, rows: 31 })).toEqual({ kind: "error", code: "INVALID" });
    expect(controlWords(f.display)).toEqual(before);
  } finally { f.cleanup(); }
});

test("R29 throwing group options preserve full block and all remaining capacity", () => {
  const f = fixture();
  const before = controlWords(f.display).slice();
  const options = { get initialMode(): "raw" { throw new Error("R29 mode accessor"); } };
  try {
    expect(() => f.authority.createGroup(options)).toThrow("R29 mode accessor");
    expect(controlWords(f.display)).toEqual(before);
    for (let i = 1; i < TERMINAL_SESSION_LIMITS.groups; i++)
      must(f.authority.createGroup({ initialMode: "raw" }));
    expect(f.authority.createGroup({ initialMode: "raw" })).toEqual({ kind: "error", code: "CAPACITY" });
  } finally { f.cleanup(); }
});

test("R29 group option reads finish before reservation and reconfirm admission", () => {
  const f = transitionFixture();
  const before = controlWords(f.display).slice();
  let reads = 0;
  const options = {
    get initialMode(): "raw" {
      reads++;
      expect(controlWords(f.display)).toEqual(before);
      f.revoke();
      return "raw";
    },
  };
  try {
    expect(() => f.authority.createGroup(options)).toThrow("R29 admission revoked");
    expect(reads).toBe(1);
    expect(controlWords(f.display)).toEqual(before);
  } finally { f.cleanup(); }
});


for (const dimension of ["columns", "rows"] as const)
  test(`R29 throwing initial ${dimension} getter leaves root transport unchanged`, () => {
    const root = createWorkerProcessTransport({ capacity: 4 });
    const before = new Uint8Array(root.directory).slice();
    const geometry = { columns: 120, rows: 24 };
    Object.defineProperty(geometry, dimension, { get() { throw new Error("R29 initial geometry"); } });
    expect(() => createTerminalSession({ controller: root, geometry })).toThrow("R29 initial geometry");
    expect(new Uint8Array(root.directory)).toEqual(before);
    const display = createTerminalSession({ controller: root, geometry: { columns: 120, rows: 24 } });
    expect(must(display.snapshot()).geometry).toEqual({ columns: 120, rows: 24, revision: 1 });
    display.close("disposed");
  });

test("R29 creation geometry getter can reenter before outer control publication", () => {
  const root = createWorkerProcessTransport({ capacity: 4 });
  let reads = 0;
  const display = createTerminalSession({
    controller: root,
    geometry: {
      get columns() {
        reads++;
        const nested = createTerminalSession({ controller: root, geometry: { columns: 103, rows: 31 } });
        expect(must(nested.snapshot()).geometry).toEqual({ columns: 103, rows: 31, revision: 1 });
        nested.close("disposed");
        return 120;
      },
      rows: 24,
    },
  });
  try {
    expect(reads).toBe(1);
    expect(must(display.snapshot()).geometry).toEqual({ columns: 120, rows: 24, revision: 1 });
  } finally { display.close("disposed"); }
});

test("R29 authority claim options throw before claiming the shared block", () => {
  const root = createWorkerProcessTransport({ capacity: 4 });
  const display = createTerminalSession({ controller: root, geometry: { columns: 120, rows: 24 } });
  const policy = tinyPolicy(new SharedArrayBuffer(132 * 4));
  const before = controlWords(display).slice();
  const options = {
    identity: display.identity,
    process: root,
    checkActive() {},
    get policy(): TerminalPolicy { throw new Error("R29 claim policy accessor"); },
  };
  try {
    expect(() => claimTerminalAuthority(options)).toThrow("R29 claim policy accessor");
    expect(controlWords(display)).toEqual(before);
    expect(claimTerminalAuthority({ identity: display.identity, process: root, checkActive() {}, policy }).kind).toBe("ok");
  } finally { display.close("disposed"); }
});

test("R29 mode options are captured once before policy and no getter follows mutation", () => {
  const f = transitionFixture();
  const controls = terminalControls(f.attachment.resolve(0))!;
  const expected = must(controls.snapshot()).selection;
  let reads = 0;
  const options = {
    expected,
    get mode(): "cooked" {
      reads++;
      if (f.cells[130] !== 0) throw new Error("mode read after policy mutation");
      return "cooked";
    },
  };
  f.fault(() => { f.cells[130]!++; return { kind: "ok", value: undefined }; });
  try {
    expect(controls.setMode(options)).toEqual({ kind: "ok", value: undefined });
    expect(reads).toBe(1);
    expect(f.cells[130]).toBe(1);
    expect(must(f.display.snapshot()).mode).toBe("cooked");
  } finally { f.cleanup(); }
});

test("R29 invalid group mode consumes no shared capacity", () => {
  const f = fixture();
  const before = controlWords(f.display).slice();
  try {
    expect(Reflect.apply(f.authority.createGroup, f.authority, [{ initialMode: "invalid" }])).toEqual({ kind: "error", code: "INVALID" });
    expect(controlWords(f.display)).toEqual(before);
  } finally { f.cleanup(); }
});
