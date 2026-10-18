import { FIXTURE_SEED, type Workload } from "./vfs-score-config.js";
import type { PersistedNode, PersistenceBatch } from "../fs/storage.js";

export const SIZES = { W1: { directories: 5_000, files: 50_000, bytes: 4096, largeFiles: 32, largeBytes: 1024 ** 2 }, W2: { packages: 2_000, sizes: [0, 128, 512, 1024, 4096, 16384, 32768, 1024, 256, 2048], replacements: 100, removals: 200, barrierEvery: 100 }, W3: { bytes: 128 * 1024 ** 2, callBytes: 64 * 1024 }, W4: { bytes: 256 * 1024, writes: 1_000, writeBytes: 4096, saves: 100 }, W5: { pages: 4, operations: 10_000 } } as const;
export function random(seed = FIXTURE_SEED): () => number {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
}
/** Random-access content: chunking does not change bytes. No random/network input. */
export function content(identity: number, size: number, offset = 0): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    let word = (FIXTURE_SEED ^ Math.imul(identity + 1, 0x9e3779b1) ^ Math.floor((offset + i) / 4)) >>> 0;
    word ^= word >>> 16; word = Math.imul(word, 0x85ebca6b); word ^= word >>> 13; word = Math.imul(word, 0xc2b2ae35); word ^= word >>> 16;
    bytes[i] = word >>> (((offset + i) % 4) * 8);
  }
  return bytes;
}
/** FNV-1a is the trace's streaming verification hash, not an integrity/durability claim. */
export function hash(bytes: Uint8Array, value = 0x811c9dc5): number { for (const byte of bytes) value = Math.imul(value ^ byte, 0x01000193) >>> 0; return value; }
export function verify(actual: Uint8Array, identity: number, size: number, offset = 0): void {
  if (actual.length !== size || hash(actual) !== hash(content(identity, size, offset))) throw new Error(`Content verification failed: ${identity}/${offset}/${size}, got ${actual.length}`);
}
const number = (n: number) => n.toString().padStart(5, "0");
export function w1Path(file: number): string { return `/d${number(Math.floor(file / 10))}/f${number(file)}`; }
export const W1_READ_SET = Array.from({ length: 128 }, (_, i) => (i * 389 + FIXTURE_SEED) % SIZES.W1.files);
/** Seed through today's storage API, outside timing. This avoids preloading 50,000
 * tiny files into a 64-KiB-per-file resident pool and does not change runtime behavior.
 * One batch has a complete graph; the production storage validates/persists it. */
export function w1Fixture(): PersistenceBatch {
  const root: PersistedNode = { ino: 1, kind: "dir", mtime: 0, size: 0, children: [] };
  const nodes: PersistedNode[] = [root], data = new Map<string, Uint8Array>();
  let ino = 2;
  for (let dir = 0; dir < SIZES.W1.directories; dir++) {
    const directory: PersistedNode = { ino: ino++, kind: "dir", mtime: 0, size: 0, children: [] };
    root.children!.push([`d${number(dir)}`, directory.ino]); nodes.push(directory);
    for (let j = 0; j < 10; j++) {
      const file = dir * 10 + j, key = `fixture-${file}`;
      directory.children!.push([`f${number(file)}`, ino]);
      nodes.push({ ino: ino++, kind: "file", mtime: 0, size: SIZES.W1.bytes, data: key }); data.set(key, content(file, SIZES.W1.bytes));
    }
    if (dir < SIZES.W1.largeFiles) {
      const key = `large-${dir}`; directory.children!.push(["large", ino]);
      nodes.push({ ino: ino++, kind: "file", mtime: 0, size: SIZES.W1.largeBytes, data: key }); data.set(key, content(SIZES.W1.files + dir, SIZES.W1.largeBytes));
    }
  }
  return { generation: 1, root: 1, upserts: nodes, removes: [], data };
}
export type TraceOperation = { kind: "mkdir" | "rename" | "remove" | "stat" | "readdir" | "read" | "barrier" | "write" | "append" | "exclusive" | "pin" | "unpin"; path: string; to?: string; identity?: number; size?: number; offset?: number; actor?: number };
export function* w2Trace(): Generator<TraceOperation> {
  yield { kind: "mkdir", path: "/staging" }; yield { kind: "mkdir", path: "/packages" };
  for (let index = 0; index < SIZES.W2.packages + SIZES.W2.replacements; index++) {
    const replacement = index >= SIZES.W2.packages, pkg = replacement ? index - SIZES.W2.packages : index;
    const stage = `/staging/p${number(pkg)}`, destination = `/packages/p${number(pkg)}`;
    yield { kind: "mkdir", path: stage };
    for (let file = 0; file < SIZES.W2.sizes.length; file++) yield { kind: "write", path: `${stage}/f${file}`, identity: index * 10 + file, size: SIZES.W2.sizes[file]! };
    if (replacement) yield { kind: "remove", path: destination };
    yield { kind: "rename", path: stage, to: destination };
    yield { kind: "stat", path: `${destination}/f4`, size: 4096 };
    yield { kind: "readdir", path: destination, size: 10 };
    yield { kind: "read", path: `${destination}/f4`, size: 4096, identity: index * 10 + 4 };
    if ((index + 1) % SIZES.W2.barrierEvery === 0) yield { kind: "barrier", path: "/" };
  }
  for (let pkg = SIZES.W2.packages - SIZES.W2.removals; pkg < SIZES.W2.packages; pkg++) yield { kind: "remove", path: `/packages/p${number(pkg)}` };
  yield { kind: "barrier", path: "/" };
}
export function* w4Trace(): Generator<TraceOperation> {
  const next = random();
  for (let i = 0; i < SIZES.W4.writes; i++) {
    yield { kind: "write", path: "/save", identity: 10_000 + i, size: SIZES.W4.writeBytes, offset: (next() % 64) * 4096 };
    yield { kind: "barrier", path: "/save" };
    if ((i + 1) % 10 === 0) {
      yield { kind: "write", path: "/temp", identity: 20_000 + i, size: 4096 };
      yield { kind: "barrier", path: "/temp" };
      yield { kind: "rename", path: "/temp", to: "/saved" };
      yield { kind: "barrier", path: "/" };
    }
  }
}
/** WAL fixture is fixed now, but executing concurrent/pinned views is deferred until
 * that product exists. Never emulate four tabs with four workspaces. */
export function* w5Trace(writers: 1 | 2): Generator<TraceOperation> {
  const next = random();
  for (let i = 0; i < SIZES.W5.operations; i++) {
    const actor = i % 4, writer = actor >= 4 - writers, name = `/mixed/n${next() % 64}`;
    const kind = i === 0 ? "pin" : i === SIZES.W5.operations - 4 ? "unpin" : writer
      ? (["write", "append", "exclusive", "rename", "remove"] as const)[next() % 5]!
      : (["read", "stat", "readdir"] as const)[next() % 3]!;
    yield { kind, actor, path: kind === "readdir" ? "/mixed" : name, to: `${name}-moved`, identity: i, size: 128 };
  }
}

export interface WorkloadIO {
  mkdir(path: string): Promise<void>;
  write(path: string, bytes: Uint8Array, offset?: number): Promise<void>;
  read(path: string, offset?: number, size?: number): Promise<Uint8Array>;
  stat(path: string): Promise<{ size: number }>;
  readdir(path: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  barrier(path?: string): Promise<void>;
}
export interface WorkloadResult {
  metrics: Record<string, number>;
  latencies: Record<string, number[]>;
  acknowledgements: { operation: number; elapsedMs: number }[];
  observations: Record<string, unknown>;
}
export async function executeWorkload(workload: Workload, io: WorkloadIO, ack: (operation: number, elapsedMs: number) => void = () => {}): Promise<WorkloadResult> {
  const result: WorkloadResult = { metrics: {}, latencies: { mutation: [], barrier: [], save: [] }, acknowledgements: [], observations: {} };
  const measure = async <T>(category: string, fn: () => Promise<T>): Promise<T> => { const t = performance.now(); const value = await fn(); (result.latencies[category] ??= []).push(performance.now() - t); return value; };
  const acknowledged = (operation: number, start: number) => { const elapsedMs = performance.now() - start; result.acknowledgements.push({ operation, elapsedMs }); ack(operation, elapsedMs); };
  if (workload === "W1") {
    const start = performance.now();
    await io.stat(w1Path(W1_READ_SET[0]!)); const bytes = await io.read(w1Path(W1_READ_SET[0]!));
    result.metrics.firstUseMs = performance.now() - start; verify(bytes, W1_READ_SET[0]!, 4096);
    const reads = performance.now();
    for (const file of W1_READ_SET) verify(await io.read(w1Path(file)), file, 4096);
    result.metrics.readSetMs = performance.now() - reads;
  } else if (workload === "W2") {
    const trace = Array.from(w2Trace());
    const payloads = new Map(trace.filter(op => op.kind === "write").map(op => [op.identity!, content(op.identity!, op.size!)]));
    const start = performance.now(); let files = 0;
    for (const op of trace) {
      if (op.kind === "mkdir") await measure("mutation", () => io.mkdir(op.path));
      if (op.kind === "write") { await measure("mutation", () => io.write(op.path, payloads.get(op.identity!)!)); files++; }
      if (op.kind === "rename") await measure("mutation", () => io.rename(op.path, op.to!));
      if (op.kind === "remove") await measure("mutation", () => io.remove(op.path));
      if (op.kind === "stat" && (await io.stat(op.path)).size !== op.size) throw new Error("W2 stat verification failed");
      if (op.kind === "readdir" && (await io.readdir(op.path)).length !== op.size) throw new Error("W2 directory verification failed");
      if (op.kind === "read") verify(await io.read(op.path), op.identity!, op.size!);
      if (op.kind === "barrier") await measure("barrier", () => io.barrier());
    }
    result.metrics.durableInstallMs = performance.now() - start;
    result.metrics.filesPerSecond = files * 1000 / result.metrics.durableInstallMs;
    // Full final tree and contents verification is deliberately outside the install timer.
    const packages = await io.readdir("/packages");
    if (packages.length !== 1800 || (await io.readdir("/staging")).length) throw new Error("W2 final tree mismatch");
    for (let pkg = 0; pkg < 1800; pkg++) {
      const path = `/packages/p${number(pkg)}`;
      if (!(packages.includes(`p${number(pkg)}`)) || (await io.readdir(path)).length !== 10) throw new Error("W2 package mismatch");
      for (let file = 0; file < 10; file++) verify(await io.read(`${path}/f${file}`), (pkg < 100 ? 2000 + pkg : pkg) * 10 + file, SIZES.W2.sizes[file]!);
    }
  } else if (workload === "W3") {
    const chunks = Array.from({ length: SIZES.W3.bytes / SIZES.W3.callBytes }, (_, i) => content(3, SIZES.W3.callBytes, i * SIZES.W3.callBytes));
    const start = performance.now();
    for (let i = 0; i < chunks.length; i++) await io.write("/sequential", chunks[i]!, i * SIZES.W3.callBytes);
    const ordinary = performance.now(); await measure("barrier", () => io.barrier("/sequential")); const durable = performance.now();
    result.metrics.ordinaryWriteMiBs = 128_000 / (ordinary - start); result.metrics.durableWriteMiBs = 128_000 / (durable - start);
    result.observations.readTemperature = "reopen the browser before executeSequentialRead; not a shared-memory reread";
  } else if (workload === "W4") {
    await io.write("/save", content(4, SIZES.W4.bytes)); await io.barrier();
    const trace = Array.from(w4Trace());
    const payloads = new Map(trace.filter(op => op.kind === "write").map(op => [op.identity!, content(op.identity!, op.size!)]));
    const expected = content(4, SIZES.W4.bytes); const start = performance.now(); let operation = 0, saveStart = start;
    for (const op of trace) {
      if (op.kind === "write") {
        saveStart = performance.now(); const bytes = payloads.get(op.identity!)!;
        await measure("mutation", () => io.write(op.path, bytes, op.offset));
        if (op.offset !== undefined) expected.set(bytes, op.offset);
      }
      if (op.kind === "rename") await measure("mutation", () => io.rename(op.path, op.to!));
      if (op.kind === "barrier") {
        await measure("barrier", () => io.barrier(op.path === "/" ? undefined : op.path));
        if (op.path !== "/temp") { result.latencies.save!.push(performance.now() - saveStart); acknowledged(operation++, start); }
      }
    }
    result.metrics.durableSavesPerSecond = 1100_000 / (performance.now() - start);
    const actual = await io.read("/save"); if (actual.length !== expected.length || hash(actual) !== hash(expected)) throw new Error("W4 final saved bytes mismatch");
    verify(await io.read("/saved"), 20_999, 4096);
  } else throw new Error("W5 must run with four real pages under the controller");
  for (const [category, values] of Object.entries(result.latencies)) if (values.length) {
    values.sort((a, b) => a - b);
    for (const [name, quantile] of [["P50", 0.5], ["P95", 0.95], ["P99", 0.99]] as const) result.metrics[`${category}${name}Ms`] = values[Math.ceil(values.length * quantile) - 1]!;
  }
  return result;
}
/** Called only after closing and relaunching the process on the preserved profile. */
export async function executeSequentialRead(io: WorkloadIO): Promise<Record<string, number>> {
  let expected = 0x811c9dc5;
  for (let offset = 0; offset < SIZES.W3.bytes; offset += SIZES.W3.callBytes) expected = hash(content(3, SIZES.W3.callBytes, offset), expected);
  const start = performance.now(); let actual = 0x811c9dc5;
  for (let offset = 0; offset < SIZES.W3.bytes; offset += SIZES.W3.callBytes) actual = hash(await io.read("/sequential", offset, SIZES.W3.callBytes), actual);
  const elapsed = performance.now() - start;
  if (actual !== expected) throw new Error("W3 sequential hash mismatch");
  return { readMiBs: 128_000 / elapsed, readMs: elapsed };
}
