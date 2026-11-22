import * as production from "../../proc/pipes.js";
import { isolatedPipes } from "./pipes-intrinsics.ts";

/** Every named step boundary in proc/pipes.ts, in the order an operation reaches them. */
export const PIPE_PAUSE_POINTS = [
  "write.loaded",
  "write.record",
  "map.loaded",
  "pool.admitted",
  "write.reserved",
  "write.copied",
  "write.failed",
  "read.loaded",
  "read.copied",
  "read.committed",
  "release.page",
  "sweep.cursors",
  "sweep.entry",
  "sweep.retag",
  "scavenge.ring",
  "relay.recover",
  "relay.head",
  "relay.staged",
  "relay.deliver",
  "reclaim.advanced",
  "pool.given",
] as const;
export type PipePausePoint = (typeof PIPE_PAUSE_POINTS)[number];
type Pipes = typeof production;
type Endpoint = ReturnType<InstanceType<Pipes["PipeController"]>["retain"]>;

interface Pause {
  point: PipePausePoint;
  /** Fire on this hit of the point, counting from when the pause was armed (1 = first). */
  hit: number;
  seen: number;
  run: () => void;
}

/** One module instance of proc/pipes.ts, standing in for one Worker or the page. Pipe code
 * keeps per-realm scratch, so a party that runs while another is paused must live in its own
 * realm, as it would in production. `pause` runs a callback when this realm reaches a named
 * point; the callback usually drives the other realm, which runs to completion before the
 * paused party resumes. Each pause fires once. */
export class PipeRealm {
  readonly pipes: Pipes;
  readonly atomics: typeof Atomics;
  /** Hits per point over this realm's life, for coverage reports. */
  readonly hits = new Map<string, number>();
  private readonly pauses: Pause[] = [];
  private readonly observers = new Map<string, () => void>();
  private running = false;
  constructor() {
    const isolated = isolatedPipes();
    this.pipes = isolated.pipes as unknown as Pipes;
    this.atomics = isolated.atomics;
    isolated.hooks.pipePause = (point) => this.reached(point);
  }
  pause(point: PipePausePoint, run: () => void, hit = 1): void {
    this.pauses.push({ point, hit, seen: 0, run });
  }
  /** Run `see` on every hit of a point, even inside another pause; it must not drive pipes. */
  observe(point: PipePausePoint, see: () => void): void {
    this.observers.set(point, see);
  }
  /** Whether every armed pause has fired. */
  get settled(): boolean {
    return this.pauses.length === 0;
  }
  clear(): void {
    this.pauses.length = 0;
  }
  /** Re-home an endpoint in this realm, as a structured-cloned handle sent to a Worker would. */
  adopt(endpoint: Endpoint): Endpoint {
    return this.pipes.attachPipeEndpoint(structuredClone(endpoint.handle()));
  }
  private reached(point: string): void {
    this.hits.set(point, (this.hits.get(point) ?? 0) + 1);
    this.observers.get(point)?.();
    if (this.running) return;
    let index = -1;
    for (const [at, pause] of this.pauses.entries()) {
      if (pause.point !== point) continue;
      pause.seen++;
      if (index < 0 && pause.seen === pause.hit) index = at;
    }
    if (index < 0) return;
    const [pause] = this.pauses.splice(index, 1);
    this.running = true;
    try {
      pause!.run();
    } finally {
      this.running = false;
    }
  }
}

const RECORD_MASK = (1 << 29) - 1;
const LOW = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1 ? 0 : 1;
function halves(value: bigint): [number, number] {
  const words = new Uint32Array(new BigInt64Array([value]).buffer);
  return [words[LOW]!, words[1 - LOW]!];
}
interface Kind {
  name: string;
  entries: (ring: number) => BigInt64Array;
  unit: number;
  span: number;
  bits: number;
  pool: production.PoolLayout;
  position: (cursor: bigint) => number;
}
/** Check a quiescent pipe (nobody paused mid-operation, relay pumped) against the page
 * invariant: every mapped page touches its ring's unread window, except the partly used page
 * at a writer ring's own position; each page has one owner; the pools' counts and bitmaps
 * match the pages the tables reference. Returns one line per violation. Local cursors only. */
export function auditPipePages(handle: production.PipeEndpointHandle): string[] {
  if (handle.registry) throw new Error("audit reads local cursors; use a pipe without a registry");
  const layout = production.pipeLayoutOf(handle);
  const { buffer, maxWriters, maxReaders, capacity } = handle;
  const problems: string[] = [];
  const ring = (index: number) => 40 + index * layout.ringBytes;
  const kinds: Kind[] = [
    {
      name: "byte",
      entries: (index) => new BigInt64Array(buffer, ring(index) + 40, layout.pages),
      unit: layout.pageBytes,
      span: capacity,
      bits: 32,
      pool: layout.bytePool,
      position: (cursor) => halves(cursor)[0],
    },
    {
      name: "record",
      entries: (index) =>
        new BigInt64Array(buffer, ring(index) + 40 + 8 * layout.pages, layout.recordPages),
      unit: layout.recordPage,
      span: layout.recordPage * layout.recordPages,
      bits: 29,
      pool: layout.recordPool,
      position: (cursor) => (halves(cursor)[1] >>> 2) & RECORD_MASK,
    },
  ];
  // The relay keeps at most one delivery outstanding; every other delivery ring is retired.
  const delivering = new Set<number>();
  for (const kind of kinds) {
    const audit = new KindAudit(kind, problems);
    for (let index = 0; index < maxWriters + maxReaders; index++) {
      const cursor = (at: number) => new BigInt64Array(buffer, ring(index) + at, 1)[0]!;
      const writer = index < maxWriters;
      if (audit.ring(index, writer, kind.position(cursor(16)), kind.position(cursor(8))) && !writer)
        delivering.add(index);
    }
    const used = new Int32Array(buffer, kind.pool.control, 1)[0]!;
    const bits = new Int32Array(buffer, kind.pool.control + 4, Math.ceil(kind.pool.shared / 32));
    let set = 0;
    for (const word of bits) for (let bit = 0; bit < 32; bit++) set += (word >>> bit) & 1;
    const referenced = audit.sharedMapped();
    if (used !== referenced || set !== referenced)
      problems.push(`${kind.name} pool counts ${used} used, ${set} set, ${referenced} mapped`);
  }
  if (delivering.size > 1)
    problems.push(`delivery rings ${Array.from(delivering).join(", ")} all hold pages`);
  return problems;
}
/** One page kind's audit across every ring of a pipe. */
class KindAudit {
  private readonly owners = new Map<number, number>();
  private readonly laps: number;
  constructor(
    private readonly kind: Kind,
    private readonly problems: string[],
  ) {
    this.laps = 2 ** (kind.bits - Math.log2(kind.span));
  }
  private wrap(value: number): number {
    return this.kind.bits === 32 ? value >>> 0 : value & RECORD_MASK;
  }
  private lap(position: number): number {
    return Math.floor(position / this.kind.span) % this.laps;
  }
  sharedMapped(): number {
    return Array.from(this.owners.keys()).filter((id) => id < this.kind.pool.shared).length;
  }
  /** Audit one ring's entries; returns whether it maps any page. */
  ring(index: number, writer: boolean, consumed: number, published: number): boolean {
    const entries = this.kind.entries(index);
    let mapped = false;
    for (let page = 0; page < entries.length; page++) {
      const [id, tag] = halves(Atomics.load(entries, page));
      if (!id) continue;
      mapped = true;
      const where = `ring ${index} ${this.kind.name} page ${page} (id ${id - 1}, lap ${tag})`;
      this.own(where, id - 1, index, writer);
      const problem = this.place({ page, pages: entries.length, tag, writer, consumed, published });
      if (problem) this.problems.push(`${where} ${problem}`);
    }
    return mapped;
  }
  private own(where: string, id: number, index: number, writer: boolean): void {
    if (this.owners.has(id))
      this.problems.push(`${where} also mapped by ring ${this.owners.get(id)}`);
    this.owners.set(id, index);
    const reserved = id - this.kind.pool.shared;
    if (reserved >= 0 && (!writer || reserved >> 1 !== index))
      this.problems.push(`${where} is another slot's reserved page`);
  }
  /** Why this entry may not be mapped where it is, or undefined if it may. */
  private place(entry: {
    page: number;
    pages: number;
    tag: number;
    writer: boolean;
    consumed: number;
    published: number;
  }): string | undefined {
    const { page, pages, tag, writer, consumed, published } = entry;
    const unit = this.kind.unit;
    const base = this.wrap(consumed - (consumed % unit));
    const window = consumed === published ? 0 : this.wrap(published - base);
    const offset = ((page - Math.floor(base / unit)) & (pages - 1)) * unit;
    const expected = this.lap(this.wrap(base + offset));
    if (offset < window) {
      const next = (expected + 1) % this.laps;
      if (tag === expected || (tag === next && offset + this.kind.span < window)) return undefined;
      return `holds unread data under lap ${expected}`;
    }
    const idle =
      writer &&
      published % unit !== 0 &&
      page === Math.floor(published / unit) % pages &&
      tag === this.lap(published);
    return idle ? undefined : "lies outside the unread window";
  }
}

/** Tracks every writer's stream. Each byte names its writer (top two bits) and that writer's
 * byte counter (low six), so `take` proves one read holds bytes of exactly one write, in that
 * writer's order, and `pending` counts committed bytes nobody has read. */
export class PipeStreams {
  readonly written = [0, 0, 0, 0];
  readonly read = [0, 0, 0, 0];
  /** Write `length` bytes as `writer`; a missing endpoint counts as closed (EBADF). */
  write(endpoint: Endpoint | undefined, writer: number, length: number): number {
    if (!endpoint) return -8;
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index++)
      bytes[index] = (writer << 6) | ((this.written[writer]! + index) & 63);
    const count = endpoint.tryWrite([bytes]);
    if (count > 0) this.written[writer]! += count;
    return count;
  }
  take(endpoint: Endpoint | undefined, length: number): number {
    if (!endpoint) return -8;
    const buffer = new Uint8Array(length);
    const count = endpoint.tryRead([buffer]);
    if (count <= 0) return count;
    const writer = buffer[0]! >> 6;
    for (let index = 0; index < count; index++) {
      const expected = (writer << 6) | ((this.read[writer]! + index) & 63);
      if (buffer[index] !== expected)
        throw new Error(`writer ${writer} byte ${this.read[writer]! + index} is ${buffer[index]}`);
    }
    this.read[writer]! += count;
    return count;
  }
  get pending(): number {
    return this.written.reduce((total, count, writer) => total + count - this.read[writer]!, 0);
  }
}

/** A realm with no pause hooks: the production module itself. */
export const plainRealm = {
  pipes: production,
  adopt(endpoint: Endpoint): Endpoint {
    return production.attachPipeEndpoint(structuredClone(endpoint.handle()));
  },
};
