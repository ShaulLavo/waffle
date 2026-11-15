import { afterEach, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import type { PluginBuilder } from "bun";
import type * as Provider from "./fixtures/process-lookup.ts";

type Provider = typeof Provider;
type Counts = Record<string, number>;
type LoadHook = (view: BigInt64Array, index: number, value: bigint) => void;
let bundle: string;
const cleanups: (() => void)[] = [];
const baseline = process.env.LOOKUP_BASELINE_REVISION;
const root = new URL("../../../", import.meta.url).pathname;

async function instrument({ path }: { path: string }) {
  const contents =
    baseline && !path.endsWith("/fixtures/process-lookup.ts")
      ? execFileSync("git", ["show", `${baseline}:${path.slice(root.length)}`], {
          cwd: root,
          encoding: "utf8",
        })
      : await Bun.file(path).text();
  return {
    loader: "ts" as const,
    contents: contents.replace(
      /new (BigInt64ArrayConstructor|Int32ArrayConstructor|TaggedCells|OutcomeCell)\(/g,
      (_, name: string) => `new (lookupConstruction(${JSON.stringify(name)}), ${name})(`,
    ),
  };
}

function setup(build: PluginBuilder) {
  build.onLoad({ filter: /\.ts$/ }, instrument);
}

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [new URL("./fixtures/process-lookup.ts", import.meta.url).pathname],
    target: "browser",
    format: "cjs",
    plugins: [{ name: "lookup-construction-controls", setup }],
  });
  if (!build.success || !build.outputs[0]) throw new Error("lookup control build failed");
  bundle = await build.outputs[0].text();
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function provider() {
  let counts: Counts = {};
  let hook: LoadHook | undefined;
  const context = {
    module: { exports: {} },
    performance,
    crypto,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    EventTarget,
    WebAssembly,
    AbortSignal,
    lookupConstruction(name: string) {
      counts[name] = (counts[name] ?? 0) + 1;
    },
    lookupAfterLoad(view: BigInt64Array, index: number, value: bigint) {
      hook?.(view, index, value);
    },
  };
  runInNewContext(
    `
    const load = Atomics.load;
    Atomics.load = new Proxy(load, { apply(target, receiver, args) {
      const value = Reflect.apply(target, receiver, args);
      if (typeof value === "bigint") lookupAfterLoad(args[0], args[1], value);
      return value;
    } });
    (function() { ${bundle} })();
  `,
    context,
  );
  const api = context.module.exports as Provider;
  return {
    api,
    hook(value?: LoadHook) {
      hook = value;
    },
    measure<T>(operation: () => T) {
      counts = {};
      const value = operation();
      return { counts, value };
    },
  };
}

function fixture(capacity = 8, live = 2, target = live - 1) {
  const p = provider();
  const { worker, directory, DescriptorTable } = p.api;
  const root = worker.createWorkerProcessTransport({ capacity });
  const children = Array.from({ length: live - 1 }, (_, index) =>
    directory.reserveDirectoryProcess(root, index + 2, 1, index + 2, 1),
  );
  const descriptors = new DescriptorTable();
  cleanups.push(() => descriptors.dispose());
  const messages: unknown[] = [];
  const initialized = p.measure(
    () =>
      new worker.WorkerProcessClient({
        transport: root,
        descriptors,
        codec: {
          export() {
            throw new Error("unused");
          },
          import() {
            throw new Error("unused");
          },
          discard() {
            throw new Error("unused");
          },
        },
        postMessage(message) {
          messages.push(message);
        },
      }),
  );
  const client = initialized.value;
  return { ...p, root, children, child: children[target - 1]!, client, messages, initialized };
}

const layouts = [8, 64, 1024].flatMap((capacity) =>
  [2, 6].flatMap((live) =>
    (live === 2 ? [1] : [1, live - 1]).map((position) => ({ capacity, live, position })),
  ),
);
for (const { capacity, live, position } of layouts)
  test(`lookup construction C=${capacity} P=${live} slot=${position}`, () => {
    const f = fixture(capacity, live, position);
    const expected = {
      BigInt64ArrayConstructor: baseline ? capacity + 32 * (position + 1) : 33,
      Int32ArrayConstructor: baseline ? position + 1 : 1,
      TaggedCells: baseline ? 15 * (position + 1) : 15,
      OutcomeCell: baseline ? 2 * (position + 1) : 2,
    };
    expect(f.initialized.counts).toEqual({
      BigInt64ArrayConstructor: 32,
      Int32ArrayConstructor: 2,
      TaggedCells: 15,
      OutcomeCell: 2,
    });
    for (let repeat = 0; repeat < 3; repeat++) {
      const result = f.measure(() => f.client.wait(1, f.child.pid));
      expect(result.value).toBeNull();
      expect(result.counts).toEqual(expected);
    }
    const started = f.measure(() => f.client.startStatus(1, f.child.pid));
    expect(started.value).toBe(-6);
    expect(started.counts).toEqual(expected);
    const exited = f.measure(() => f.client.childExited(1, f.child.pid));
    expect(exited.value).toBe(false);
    expect(exited.counts).toEqual(expected);
    console.log(
      JSON.stringify({
        capacity,
        live,
        position,
        initialization: f.initialized.counts,
        lookup: expected,
      }),
    );
    expect(f.messages).toEqual([]);
  });

function childError(operation: () => unknown) {
  expect(operation).toThrow(expect.objectContaining({ errno: 12 }));
}

function processRow(f: ReturnType<typeof fixture>, handle = f.child) {
  const own = f.api.directory.directoryObservationLocation(f.root).identity;
  const child = f.api.directory.directoryObservationLocation(handle).identity;
  const bytes = (child.byteOffset - own.byteOffset) / (handle.slot - f.root.slot);
  return new BigInt64Array(handle.directory, child.byteOffset, bytes / 8);
}

for (const capacity of [8, 64, 1024])
  test(`sparse lookup at the last physical slot C=${capacity}`, () => {
    const f = fixture(capacity);
    const raw = processRow(f);
    const destination = new BigInt64Array(
      f.root.directory,
      raw.byteOffset + (capacity - 2) * raw.byteLength,
      raw.length,
    );
    destination.set(raw);
    raw.fill(0n);
    Object.assign(f.child, { slot: capacity - 1 });
    const result = f.measure(() => f.client.wait(1, f.child.pid));
    expect(result.value).toBeNull();
    expect(result.counts.BigInt64ArrayConstructor).toBe(33);
    const missing = f.measure(() => childError(() => f.client.wait(1, 999)));
    expect(missing.counts).toEqual({ BigInt64ArrayConstructor: 1 });
  });

test("lookup preserves parent checks, missing targets, start diagnostics and collection", () => {
  const f = fixture();
  const { directory, outcome, observation } = f.api;
  childError(() => f.client.wait(9, f.child.pid));
  childError(() => f.client.wait(1, 999));
  expect(f.client.startStatus(1, f.child.pid)).toBe(-6);
  expect(f.client.spawnDiagnostic(1, f.child.pid)).toBe("");
  const state = directory.directoryState(f.child);
  outcome.claimOutcome(
    state.signals.outcome,
    { kind: "start-failed", code: 2 },
    undefined,
    "lookup failure detail",
  );
  expect(f.client.spawnDiagnostic(1, f.child.pid)).toBe("lookup failure detail");
  expect(f.client.startStatus(1, f.child.pid)).toBe(44);
  expect(f.client.childExited(1, f.child.pid)).toBe(false);
  expect(f.client.wait(1, f.child.pid)).toBeNull();
  const returned = observation.captureNativeReturn(f.child);
  returned();
  directory.confirmDirectoryProcess(f.child);
  expect(f.client.childExited(1, f.child.pid)).toBe(true);
  expect(f.client.wait(1, f.child.pid)).toMatchObject({ kind: "start-failed", code: 2 });
  childError(() => f.client.startStatus(1, f.child.pid));
  childError(() => f.client.childExited(1, f.child.pid));
  childError(() => f.client.spawnDiagnostic(1, f.child.pid));
  childError(() => f.client.wait(1, f.child.pid));
  expect(f.messages).toHaveLength(1);
});

for (const physicalFirst of [false, true])
  test(`lookup rejects recycled rows and jobs, physical return first=${physicalFirst}`, () => {
    const f = fixture(2);
    const { directory, outcome, observation } = f.api;
    const state = directory.directoryState(f.child);
    const returned = observation.captureNativeReturn(f.child);
    outcome.claimOutcome(state.signals.outcome, { kind: "exited", code: 7 });
    if (physicalFirst) returned();
    directory.confirmDirectoryProcess(f.child);
    expect(f.client.wait(1, f.child.pid)).toMatchObject({ code: 7 });
    childError(() => f.client.wait(1, f.child.pid));
    directory.collectDirectoryJob(f.root.directory, state.jobSlot, state.job);
    if (!physicalFirst)
      expect(() => directory.reserveDirectoryProcess(f.root, 77, 1, 77, 1)).toThrow(
        expect.objectContaining({ errno: 6 }),
      );
    returned();
    const next = directory.reserveDirectoryProcess(f.root, 77, 1, 77, 1);
    expect(next.slot).toBe(f.child.slot);
    expect(directory.directoryState(next).jobSlot).toBe(state.jobSlot);
    childError(() => f.client.wait(1, f.child.pid));
    expect(f.client.wait(1, next.pid)).toBeNull();
    expect(() => state.confirmed.load()).toThrow();
    expect(() => state.jobPending.load()).toThrow();
  });

test("lookups see late reservations and directory rebinding without a cached locator", () => {
  const f = fixture();
  childError(() => f.client.wait(1, 88));
  const late = f.api.directory.reserveDirectoryProcess(f.root, 88, 1, 88, 1);
  expect(f.client.wait(1, late.pid)).toBeNull();
  const replacement = f.api.worker.createWorkerProcessTransport({ capacity: 64 });
  const newChild = f.api.directory.reserveDirectoryProcess(replacement, 99, 1, 99, 1);
  Object.assign(f.root, { directory: replacement.directory });
  childError(() => f.client.wait(1, late.pid));
  expect(f.client.wait(1, newChild.pid)).toBeNull();
});

test("repeated lookup samples current parent membership and executable entry", () => {
  const f = fixture();
  expect(f.client.wait(1, f.child.pid)).toBeNull();
  const raw = processRow(f);
  Atomics.store(raw, 1, f.api.control.packedControl(f.child.pid, 9));
  childError(() => f.client.wait(1, f.child.pid));
  Atomics.store(raw, 1, f.api.control.packedControl(f.child.pid, 1));
  f.api.outcome.markStarted(f.api.directory.directoryState(f.child).signals.outcome);
  expect(f.client.startStatus(1, f.child.pid)).toBe(0);
  expect(f.client.wait(1, f.child.pid)).toBeNull();
});

for (const changed of ["target", "unrelated"] as const)
  test(`lookup identity scan tolerates ${changed} retirement without adopting replacements`, () => {
    const f = fixture(8, 3, 2);
    const selected = changed === "unrelated" ? f.children[0]! : f.child;
    const state = f.api.directory.directoryState(selected);
    const returned = f.api.observation.captureNativeReturn(selected);
    const raw = processRow(f, selected);
    const scanIndex = f.child.slot * raw.length;
    let raced = false;
    f.hook((view, index) => {
      if (view.buffer !== f.root.directory || view.byteOffset !== 32 || index !== scanIndex) return;
      f.hook();
      raced = true;
      f.api.outcome.claimOutcome(state.signals.outcome, { kind: "exited", code: 3 });
      returned();
      f.api.directory.confirmDirectoryProcess(selected);
      f.api.directory.collectDirectoryProcess(selected);
      f.api.directory.collectDirectoryJob(selected.directory, state.jobSlot, state.job);
      f.api.directory.reserveDirectoryProcess(f.root, 99, 1, 99, 1);
    });
    if (changed === "unrelated") expect(f.client.wait(1, f.child.pid)).toBeNull();
    else childError(() => f.client.wait(1, f.child.pid));
    expect(raced).toBe(true);
    expect(f.client.wait(1, 99)).toBeNull();
  });

test("job retirement during state acquisition rejects its captured job incarnation", () => {
  const f = fixture();
  const raw = processRow(f);
  const state = f.api.directory.directoryState(f.child);
  let raced = false;
  f.hook((view, index) => {
    if (view.buffer !== raw.buffer || view.byteOffset !== raw.byteOffset || index !== 75) return;
    f.hook();
    raced = true;
    // Keep the process row live while another collector retires and reuses its job.
    const jobIdentity = state.jobPending.validity!;
    Atomics.store(
      new BigInt64Array(jobIdentity.buffer, jobIdentity.byteOffset, 1),
      0,
      f.api.control.packedControl(state.job + 100, 1),
    );
  });
  childError(() => f.client.wait(1, f.child.pid));
  expect(raced).toBe(true);
});

for (const boundary of ["confirmed", "job-pending"] as const)
  test(`collection at the native ${boundary} read rejects replacement process and job rows`, () => {
    const f = fixture();
    const { directory, outcome, observation } = f.api;
    const state = directory.directoryState(f.child);
    outcome.claimOutcome(state.signals.outcome, { kind: "exited", code: 5 });
    observation.captureNativeReturn(f.child)();
    directory.confirmDirectoryProcess(f.child);
    const offset =
      boundary === "confirmed" ? state.confirmed.byteOffset : state.jobPending.byteOffset;
    let raced = false;
    f.hook((view, index) => {
      if (view.buffer !== f.root.directory || view.byteOffset !== offset || index !== 0) return;
      f.hook();
      raced = true;
      directory.collectDirectoryProcess(f.child);
      directory.collectDirectoryJob(f.root.directory, state.jobSlot, state.job);
      directory.reserveDirectoryProcess(f.root, 99, 1, 99, 1);
    });
    expect(() => f.client.wait(1, f.child.pid)).toThrow(expect.objectContaining({ errno: 71 }));
    expect(raced).toBe(true);
    expect(f.client.wait(1, 99)).toBeNull();
  });

test("the caller's physical slot cannot authorize a replacement incarnation", () => {
  const f = fixture();
  const identity = f.api.directory.directoryObservationLocation(f.root).identity;
  Atomics.store(identity, 0, f.api.control.packedControl(99, 1));
  expect(() => f.client.jobOf(99)).toThrow(expect.objectContaining({ errno: 71 }));
});

test("a sealed job remains excluded from target and retained-child lookups", () => {
  const f = fixture();
  const state = f.api.directory.directoryState(f.child);
  f.api.control.controlStore(state.jobPending, 0, -1);
  expect(() => f.client.jobOf(f.child.pid)).toThrow(expect.objectContaining({ errno: 71 }));
  childError(() => f.client.wait(1, f.child.pid));
  childError(() => f.client.startStatus(1, f.child.pid));
  childError(() => f.client.childExited(1, f.child.pid));
  childError(() => f.client.spawnDiagnostic(1, f.child.pid));
});
