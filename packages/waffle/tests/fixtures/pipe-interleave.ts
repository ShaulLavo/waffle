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
  for (const kind of kinds) {
    const wrap = (value: number) => (kind.bits === 32 ? value >>> 0 : value & RECORD_MASK);
    const laps = 2 ** (kind.bits - Math.log2(kind.span));
    const lap = (position: number) => Math.floor(position / kind.span) % laps;
    const owners = new Map<number, number>();
    for (let index = 0; index < maxWriters + maxReaders; index++) {
      const writer = index < maxWriters;
      const published = kind.position(new BigInt64Array(buffer, ring(index) + 8, 1)[0]!);
      const consumed = kind.position(new BigInt64Array(buffer, ring(index) + 16, 1)[0]!);
      const base = wrap(consumed - (consumed % kind.unit));
      const window = consumed === published ? 0 : wrap(published - base);
      const entries = kind.entries(index);
      const pages = entries.length;
      for (let page = 0; page < pages; page++) {
        const [id, tag] = halves(Atomics.load(entries, page));
        if (!id) continue;
        const where = `ring ${index} ${kind.name} page ${page} (id ${id - 1}, lap ${tag})`;
        if (owners.has(id - 1)) problems.push(`${where} also mapped by ring ${owners.get(id - 1)}`);
        owners.set(id - 1, index);
        const reserved = id - 1 - kind.pool.shared;
        if (reserved >= 0 && (!writer || reserved >> 1 !== index))
          problems.push(`${where} is another slot's reserved page`);
        const offset = ((page - Math.floor(base / kind.unit)) & (pages - 1)) * kind.unit;
        const expected = lap(wrap(base + offset));
        if (offset < window) {
          const next = (expected + 1) % laps;
          if (tag !== expected && !(tag === next && offset + kind.span < window))
            problems.push(`${where} holds unread data under lap ${expected}`);
          continue;
        }
        const idle =
          writer &&
          published % kind.unit !== 0 &&
          page === Math.floor(published / kind.unit) % pages &&
          tag === lap(published);
        if (!idle) problems.push(`${where} lies outside the unread window`);
      }
    }
    const used = new Int32Array(buffer, kind.pool.control, 1)[0]!;
    const bits = new Int32Array(buffer, kind.pool.control + 4, Math.ceil(kind.pool.shared / 32));
    let set = 0;
    for (const word of bits) for (let bit = 0; bit < 32; bit++) set += (word >>> bit) & 1;
    const referenced = Array.from(owners.keys()).filter((id) => id < kind.pool.shared).length;
    if (used !== referenced || set !== referenced)
      problems.push(`${kind.name} pool counts ${used} used, ${set} set, ${referenced} mapped`);
  }
  return problems;
}

/** A realm with no pause hooks: the production module itself. */
export const plainRealm = {
  pipes: production,
  adopt(endpoint: Endpoint): Endpoint {
    return production.attachPipeEndpoint(structuredClone(endpoint.handle()));
  },
};
