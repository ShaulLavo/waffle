import { expect, test } from "bun:test";
import { DescriptorTable, type Readiness } from "../core/descriptors.js";
import { MemFS } from "../fs/memory.js";
import { ProcessABI } from "../proc/abi.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
  type WorkerProcessTransport,
} from "../proc/worker-client.js";
import {
  attachTerminal,
  claimTerminalAuthority,
  createTerminalInput,
  createTerminalInputPolicy,
  createTerminalSession,
  pushTerminalInput,
  type TerminalResult,
} from "../browser/runtime-terminals.js";

function must<T>(result: TerminalResult<T>): T {
  if (result.kind === "error") throw new Error(result.code);
  return result.value;
}

function controlBuffer(identity: unknown): SharedArrayBuffer {
  if (typeof identity !== "object" || identity === null || !("buffer" in identity))
    throw new Error("missing terminal control block");
  if (!(identity.buffer instanceof SharedArrayBuffer)) throw new Error("invalid terminal buffer");
  return identity.buffer;
}

function fixture() {
  const root = createWorkerProcessTransport({ capacity: 8 });
  const descriptors = new DescriptorTable();
  let child: WorkerProcessTransport | undefined;
  const unused = (): never => {
    throw new Error("no descriptor transfer expected");
  };
  const client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: { export: unused, import: unused, discard: unused },
    postMessage(message) {
      if (message.operation === "spawn") child = message.transport;
    },
  });
  client.spawn(root.pid, {
    executable: "/background",
    argv: [],
    env: {},
    cwd: "/",
    job: -1,
    fds: [],
  });
  if (!child) throw new Error("background process not reserved");
  const background = child;
  const input = createTerminalInput();
  const policy = createTerminalInputPolicy({ input });
  const display = createTerminalSession({ controller: root, geometry: { columns: 80, rows: 24 } });
  const authority = must(
    claimTerminalAuthority({ identity: display.identity, process: root, checkActive() {}, policy }),
  );
  const editor = must(authority.createGroup({ initialMode: "raw" }));
  must(authority.admitExisting({ group: editor, pid: root.pid }));
  must(authority.acquire({ group: editor, expected: null }));
  const group = must(authority.createGroup({ initialMode: "raw" }));
  const member = must(authority.admitExisting({ group, pid: background.pid }));
  must(authority.startBackground(group));
  const attachment = attachTerminal({
    context: display.inherit(),
    process: root,
    checkActive() {},
    policy,
  });
  const stream = attachment.resolve(0);
  descriptors.openAt(0, stream, (1n << 29n) - 1n, 0n);
  const common = workerProcessState(root).wake;
  const gate = new BigInt64Array(controlBuffer(display.identity), 64, 1);
  const line = new TextEncoder().encode("kill %1; wait; echo __BACKGROUND_REAPED__\r");
  must(pushTerminalInput(display, input, line));
  expect(stream.tryRead?.([new Uint8Array(24)])).toBe(24);
  return {
    root, background, client, descriptors, input, display, attachment, stream, common, gate,
    backgroundContext: member.context,
    cleanup() {
      descriptors.dispose();
      attachment.dispose();
      display.close("disposed");
    },
  };
}

test("a background no-op release wakes the fully notified infinite terminal poll", () => {
  const f = fixture();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  view.setUint32(128, 0, true);
  view.setUint32(132, 0, true);
  view.setBigUint64(136, 77n, true);
  let expected: number | undefined;
  let waits = 0;
  const parked = new Error("stop at real infinite poll wait");
  const abi = new ProcessABI({
    memory,
    descriptors: f.descriptors,
    fs: new MemFS(),
    pid: f.root.pid,
    service: f.client,
    signals: workerProcessState(f.root).signals,
    wake: f.common,
    wait(milliseconds, word, sequence) {
      expect(milliseconds).toBe(Infinity);
      expect(word).toBe(f.common);
      expected = sequence;
      waits++;
      throw parked;
    },
  });
  const during: Readiness[] = [];
  const background = attachTerminal({
    context: f.backgroundContext,
    process: f.background,
    policy: createTerminalInputPolicy({ input: f.input.buffer }),
    checkActive() {
      if (Atomics.load(f.gate, 0) !== BigInt(f.background.pid)) return;
      during.push(f.stream.readiness());
      expect(f.stream.tryRead?.([new Uint8Array(1)])).toBe(-6);
      expect(() => abi.imports.poll!(128, 1, -1, 256)).toThrow(parked);
    },
  });
  try {
    expect(background.resolve(0).tryRead?.([new Uint8Array(1)])).toBe(-6);
    expect(during).toEqual([{ readable: false, writable: false, hangup: false, nbytes: 0 }]);
    expect(f.input.available()).toBe(18);
    expect(waits).toBe(1);
    if (expected === undefined) throw new Error("poll never reached its notified wait");
    expect(Atomics.wait(f.common, 0, expected, 0)).toBe("not-equal");
    expect(abi.imports.poll!(128, 1, -1, 256)).toBe(1);
    expect(view.getBigUint64(256, true)).toBe(77n);
    expect(f.stream.tryRead?.([new Uint8Array(18)])).toBe(18);
  } finally {
    background.dispose();
    f.cleanup();
  }
});

test("uncontended no-op terminal transactions remain silent", () => {
  const f = fixture();
  try {
    const before = Atomics.load(f.common, 0);
    expect(f.display.snapshot().kind).toBe("ok");
    expect(f.stream.readiness().nbytes).toBe(18);
    expect(Atomics.load(f.common, 0)).toBe(before);
  } finally {
    f.cleanup();
  }
});
