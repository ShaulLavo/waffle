import { afterAll, describe, expect, test } from "bun:test";
import { pipeSharedPagesInUse } from "../proc/pipes.js";
import { PIPE_PAUSE_POINTS, PipeRealm, auditPipePages } from "./fixtures/pipe-interleave.ts";

// Pause one party at every named step of the pipe and run another party's operation there,
// then check that the pipe still delivers every committed byte once, in order, one write per
// read, wakes waiters whenever it returns a page, and holds no stray shared page once drained.
// Three realms stand in for the page (relay and one writer) and two guest Workers.
type Controller = InstanceType<PipeRealm["pipes"]["PipeController"]>;
type Endpoint = ReturnType<Controller["retain"]>;
type RealmName = "page" | "a" | "b";
type Mode = "direct" | "relay";
const AGAIN = -6;

const realms: Record<RealmName, PipeRealm> = {
  page: new PipeRealm(),
  a: new PipeRealm(),
  b: new PipeRealm(),
};

class Streams {
  readonly written = [0, 0, 0, 0];
  readonly read = [0, 0, 0, 0];
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

/** One scenario's pipe: the page owns the controller, writer 0 and the host reader; guest a
 * owns reader 1 and writer 1; guest b owns reader 2 (relay) and writers 2 and 3. */
class World {
  readonly streams = new Streams();
  readonly pipe: Controller;
  readonly writers: (Endpoint | undefined)[] = [];
  readonly readers: (Endpoint | undefined)[] = [];
  host?: Endpoint;
  revoked = 0;
  missedWakes = 0;
  constructor(readonly mode: Mode) {
    const { page, a, b } = realms;
    this.pipe = new page.pipes.PipeController({ relay: "manual", maxWriters: 3, maxReaders: 3 });
    for (const realm of [page, a, b])
      realm.observe("pool.given", () => {
        this.given = Atomics.load(this.pipe.notification, 0);
      });
    const host = this.pipe.retain(1, "read");
    this.writers[0] = this.pipe.retain(10, "write");
    this.writers[1] = a.adopt(this.pipe.retain(11, "write"));
    this.writers[2] = b.adopt(this.pipe.retain(12, "write"));
    if (mode === "direct") {
      this.readers[1] = a.adopt(host);
      return;
    }
    this.host = host;
    this.readers[1] = a.adopt(host.forProcess(2));
    this.readers[2] = b.adopt(host.forProcess(3));
  }
  get any(): Endpoint {
    return (this.host ?? this.readers[1])!;
  }
  shared(): number {
    const used = pipeSharedPagesInUse(this.any.handle());
    return used.bytes + used.records;
  }
  pump(): void {
    if (this.mode === "relay") this.pipe.pumpRelay();
  }
  readAll(reader: number): void {
    for (let round = 0; round < 4; round++) {
      if (this.streams.take(this.readers[reader], 65536) > 0) round = 0;
      else if (this.mode === "relay") return;
    }
  }
  /** Top-level step. Every page returned must be followed by a wake before the step ends, and
   * once the relay has run, the pipe must satisfy the page invariant. */
  step(run: () => void): void {
    this.given = undefined;
    run();
    if (this.given !== undefined && Atomics.load(this.pipe.notification, 0) === this.given)
      this.missedWakes++;
    this.pump();
    for (const problem of auditPipePages(this.any.handle()))
      this.problems.push(`after step ${this.steps}: ${problem}`);
    this.steps++;
  }
  /** The wake word when a page was last returned during the current step. */
  given?: number;
  steps = 0;
  readonly problems: string[] = [];
}

interface Action {
  name: string;
  /** Realms the action runs code in; it never runs inside one of them. */
  uses: readonly RealmName[];
  modes?: readonly Mode[];
  run(world: World): void;
}
const actions: readonly Action[] = [
  { name: "page writes 10", uses: ["page"], run: (w) => void w.streams.write(w.writers[0], 0, 10) },
  {
    name: "page writes 40000",
    uses: ["page"],
    run: (w) => void w.streams.write(w.writers[0], 0, 40000),
  },
  { name: "a writes 10", uses: ["a"], run: (w) => void w.streams.write(w.writers[1], 1, 10) },
  {
    name: "b writes 40000",
    uses: ["b"],
    run: (w) => void w.streams.write(w.writers[2], 2, 40000),
  },
  { name: "a reads 1", uses: ["a"], run: (w) => void w.streams.take(w.readers[1], 1) },
  { name: "a reads all", uses: ["a"], run: (w) => w.readAll(1) },
  {
    name: "b reads all",
    uses: ["b"],
    modes: ["relay"],
    run: (w) => w.readAll(2),
  },
  { name: "page pumps", uses: ["page"], modes: ["relay"], run: (w) => w.pump() },
  {
    name: "page revokes a's writer",
    uses: ["page"],
    run: (w) => {
      w.pipe.revoke(11);
      w.revoked++;
    },
  },
  {
    name: "b closes its reader and the page reuses the slot",
    uses: ["b", "page"],
    modes: ["relay"],
    run: (w) => {
      w.readers[2]?.close();
      w.readers[2] = undefined;
      // A closed reader's slot stays busy (ENFILE) until the relay recovers its delivery.
      try {
        w.readers[2] = realms.b.adopt(w.host!.forProcess(40 + w.revoked));
      } catch (error) {
        if (!(error as Error).message.includes("process limit reached")) throw error;
      }
    },
  },
];

/** A fixed workload that passes every pause point at least once in some mode. */
function workload(world: World): void {
  const { streams, writers } = world;
  const steps: (() => void)[] = [
    () => streams.write(writers[0], 0, 5000),
    () => streams.write(writers[1], 1, 100),
    () => streams.take(world.readers[1], 3000),
    () => world.pump(),
    () => streams.take(world.readers[2], 100),
    () => world.pump(),
    () => streams.write(writers[0], 0, 65536),
    () => streams.write(writers[1], 1, 65536),
    () => streams.write(writers[2], 2, 4096),
    () => world.readAll(1),
    () => world.pump(),
    () => world.readAll(2),
    () => world.pump(),
    () => world.readAll(1),
    () => streams.write(writers[1], 1, 4097),
    () => streams.take(world.readers[1], 64),
    () => {
      // Replace writer 2: its slot is reclaimed after it closes.
      writers[2]?.close();
      writers[3] = realms.b.adopt(world.pipe.retain(13, "write"));
      writers[2] = undefined;
    },
    () => streams.write(writers[3], 3, 9000),
    () => world.pump(),
    () => world.readAll(1),
    () => world.pump(),
    () => world.readAll(2),
  ];
  for (const run of steps) world.step(run);
}
/** Drain everything still committed, then return every idle partial page. */
function settle(world: World): void {
  const { streams } = world;
  const drain = () => {
    for (let round = 0; round < 200 && streams.pending > 0; round++) {
      for (const reader of [1, 2]) streams.take(world.readers[reader], 65536);
      world.pump();
    }
  };
  drain();
  expect(streams.pending).toBe(0);
  for (const [index, writer] of world.writers.entries())
    if (writer && streams.write(writer, index, 1) === 1) drain();
  world.pump();
  expect(streams.pending).toBe(0);
}

const fired = new Map<string, number>();
afterAll(() => {
  // Every point was paused at, with some other party running, in at least one scenario.
  expect(PIPE_PAUSE_POINTS.filter((point) => !fired.get(point))).toEqual([]);
});

for (const mode of ["direct", "relay"] as const) {
  describe(`${mode} pipe, one party paused while another runs`, () => {
    test("the workload alone stays exact", () => {
      const world = new World(mode);
      workload(world);
      settle(world);
      expect(world.missedWakes).toBe(0);
      expect(world.problems).toEqual([]);
      expect(world.shared()).toBe(0);
    });
    for (const point of PIPE_PAUSE_POINTS)
      for (const paused of ["page", "a", "b"] as const)
        test(`${paused} paused at ${point}`, () => {
          const failures: string[] = [];
          for (const action of actions) {
            if (action.uses.includes(paused) || (action.modes && !action.modes.includes(mode)))
              continue;
            for (const hit of [1, 3]) {
              const world = new World(mode);
              let ran = false;
              // A write fails to publish only when someone revokes it mid-copy: the page does
              // that first, then the second party runs while the failed write sweeps.
              if (point === "write.failed" && paused !== "page")
                realms[paused].pause(
                  "write.copied",
                  () => {
                    for (const pid of paused === "a" ? [11] : [12, 13]) world.pipe.revoke(pid);
                    world.revoked++;
                  },
                  hit,
                );
              realms[paused].pause(
                point,
                () => {
                  ran = true;
                  action.run(world);
                },
                hit,
              );
              try {
                workload(world);
                settle(world);
                if (world.missedWakes) failures.push(`${action.name} #${hit}: missed wake`);
                for (const problem of world.problems.slice(0, 2))
                  failures.push(`${action.name} #${hit}: ${problem}`);
                // A revoked writer may keep the one partly used page it last wrote.
                const allowed = world.revoked ? 2 * world.revoked : 0;
                if (world.shared() > allowed)
                  failures.push(`${action.name} #${hit}: ${world.shared()} shared pages left`);
              } catch (error) {
                failures.push(`${action.name} #${hit}: ${(error as Error).message}`);
              } finally {
                realms[paused].clear();
                world.pipe.dispose();
              }
              if (ran) fired.set(point, (fired.get(point) ?? 0) + 1);
            }
          }
          expect(failures).toEqual([]);
        });
  });
}
