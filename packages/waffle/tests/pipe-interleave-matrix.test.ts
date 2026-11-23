import { afterAll, describe, expect, test } from "bun:test";
import { PipeErrno, pipeSharedPagesInUse } from "../proc/pipes.js";
import {
  PIPE_PAUSE_POINTS,
  PipeRealm,
  PipeStreams as Streams,
  auditPipePages,
} from "./fixtures/pipe-interleave.ts";

// Pause one party at every named step of the pipe and run another party's operation there,
// then check that the pipe still delivers every committed byte once, in order, one write per
// read, wakes waiters whenever it returns a page, and holds no stray shared page once drained.
// Three realms stand in for the page (relay and one writer) and two guest Workers.
type Controller = InstanceType<PipeRealm["pipes"]["PipeController"]>;
type Registry = InstanceType<PipeRealm["pipes"]["PipePublicationRegistry"]>;
type Endpoint = ReturnType<Controller["retain"]>;
type RealmName = "page" | "a" | "b";
type Mode = "direct" | "relay";
/** Where cursors live: in the pipe, or in reusable cells of a shared registry. */
type Backing = "local" | "registry";

const realms: Record<RealmName, PipeRealm> = {
  page: new PipeRealm(),
  a: new PipeRealm(),
  b: new PipeRealm(),
};

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
  readonly registry?: Registry;
  /** Registry backing: a small pipe opened on cells other pipes just returned. */
  private bystander?: { pipe: Controller; reader: Endpoint; writer: Endpoint; pending: number };
  constructor(
    readonly mode: Mode,
    readonly backing: Backing = "local",
  ) {
    const { page, a, b } = realms;
    if (backing === "registry") {
      this.registry = new page.pipes.PipePublicationRegistry({
        processCapacity: 64,
        cellsPerProcess: 1,
        maxCells: 256,
      });
      for (let pid = 1; pid < 64; pid++) this.registry.registerProcess(pid);
    }
    this.pipe = new page.pipes.PipeController({
      relay: "manual",
      maxWriters: 3,
      maxReaders: 3,
      registry: this.registry,
    });
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
  /** Retire the last bystander, returning its cells, and open a new one that takes freed
   * cells (the main pipe's, if a reclaim just released some). A paused party acting on a
   * cell it no longer holds would corrupt this bystander, which `checkBystander` catches. */
  churn(): void {
    this.checkBystander();
    this.closeBystander();
    const pipe = new realms.page.pipes.PipeController({
      registry: this.registry,
      capacity: 8,
      maxWriters: 1,
      maxReaders: 1,
      relay: "manual",
    });
    const reader = pipe.retain(60, "read"),
      writer = pipe.retain(61, "write");
    this.bystander = { pipe, reader, writer, pending: 0 };
    if (writer.tryWrite([new Uint8Array([0x5a])]) === 1) this.bystander.pending = 1;
  }
  checkBystander(): void {
    const bystander = this.bystander;
    if (!bystander) return;
    const output = new Uint8Array(8);
    const expected = bystander.pending ? 1 : -PipeErrno.AGAIN;
    const got = bystander.reader.tryRead([output]);
    if (got !== expected || (got === 1 && output[0] !== 0x5a))
      this.problems.push(`bystander read ${got} (byte ${output[0]}), expected ${expected}`);
    bystander.pending = 0;
    if (bystander.writer.tryWrite([new Uint8Array([0x5b])]) !== 1)
      this.problems.push("bystander write failed");
    else if (bystander.reader.tryRead([output]) !== 1 || output[0] !== 0x5b)
      this.problems.push("bystander lost a write");
  }
  closeBystander(): void {
    if (!this.bystander) return;
    this.bystander.reader.close();
    this.bystander.writer.close();
    if (!this.bystander.pipe.closed) this.problems.push("bystander did not retire");
    this.bystander = undefined;
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
  backings?: readonly Backing[];
  run(world: World): void;
}
/** Reserve a writer or reader that may legitimately be refused: slots full or pid revoked. */
function tryAdopt(realm: PipeRealm, retain: () => Endpoint): Endpoint | undefined {
  try {
    return realm.adopt(retain());
  } catch (error) {
    const message = (error as Error).message;
    if (!message.includes("process limit reached") && !message.includes("revoked")) throw error;
    return undefined;
  }
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
  // One large read and no retry, so no fresh demand hides a ring the relay forgot.
  { name: "a reads once", uses: ["a"], run: (w) => void w.streams.take(w.readers[1], 65536) },
  {
    name: "b reads once",
    uses: ["b"],
    modes: ["relay"],
    run: (w) => void w.streams.take(w.readers[2], 65536),
  },
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
  // Registry cells: a reclaim or retirement returns cells, and the page reuses them at once.
  {
    name: "page churns registry cells",
    uses: ["page"],
    backings: ["registry"],
    run: (w) => w.churn(),
  },
  {
    name: "page revokes and collects a's writer, then churns",
    uses: ["page"],
    backings: ["registry"],
    run: (w) => {
      w.pipe.revoke(11);
      w.registry!.collectProcess(11);
      w.revoked++;
      w.churn();
    },
  },
  {
    name: "b's writer slot is reclaimed, then the page churns",
    uses: ["b", "page"],
    backings: ["registry"],
    run: (w) => {
      w.writers[2]?.close();
      w.writers[2] = undefined;
      w.writers[3] ??= tryAdopt(realms.b, () => w.pipe.retain(13, "write"));
      w.churn();
    },
  },
  {
    name: "b's reader slot is reused, then the page churns",
    uses: ["b", "page"],
    modes: ["relay"],
    backings: ["registry"],
    run: (w) => {
      w.readers[2]?.close();
      w.readers[2] = tryAdopt(realms.b, () => w.host!.forProcess(40 + w.revoked));
      w.churn();
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
    () => streams.write(writers[0], 0, 300),
    () => streams.take(world.readers[2], 300),
    () => world.pump(),
    () => {
      // Read a delivery, close, and reuse the slot before the relay runs again.
      if (world.mode !== "relay") return;
      streams.take(world.readers[2], 65536);
      world.readers[2]?.close();
      world.readers[2] = undefined;
      try {
        world.readers[2] = realms.b.adopt(world.host!.forProcess(30));
      } catch (error) {
        if (!(error as Error).message.includes("process limit reached")) throw error;
      }
    },
    () => {
      // Replace writer 2: its slot is reclaimed after it closes.
      writers[2]?.close();
      // Registry revocation is process-wide, so a pid revoked earlier cannot come back.
      const retain = () => world.pipe.retain(13, "write");
      writers[3] =
        world.backing === "registry" ? tryAdopt(realms.b, retain) : realms.b.adopt(retain());
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

/** Run the workload with `action` at the `hit`-th time `paused` reaches `point`. */
function scenario(
  mode: Mode,
  backing: Backing,
  point: (typeof PIPE_PAUSE_POINTS)[number],
  paused: RealmName,
  action: Action,
  hit: number,
): string[] {
  const world = new World(mode, backing);
  const failures: string[] = [];
  let ran = false;
  // A write fails to publish only when someone revokes it mid-copy: the page does that first,
  // then the second party runs while the failed write sweeps.
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
    world.checkBystander();
    if (world.missedWakes) failures.push("missed wake");
    failures.push(...world.problems.slice(0, 2));
    // A revoked writer may keep the one partly used page it last wrote.
    const allowed = world.revoked ? 2 * world.revoked : 0;
    if (world.shared() > allowed) failures.push(`${world.shared()} shared pages left`);
  } catch (error) {
    failures.push((error as Error).message);
  } finally {
    realms[paused].clear();
    world.pipe.dispose();
    world.closeBystander();
  }
  // Every pipe retired and nothing is paused: every registry cell came back.
  const held = world.registry?.cellsInUse ?? 0;
  if (held) failures.push(`${held} registry cells still held`);
  if (ran) fired.set(point, (fired.get(point) ?? 0) + 1);
  return failures;
}

const fired = new Map<string, number>();
afterAll(() => {
  // Every point was paused at, with some other party running, in at least one scenario. A
  // tag-back needs an aborted write that wrapped onto unread bytes; pipe-interleave.test.ts
  // pauses there directly.
  const targeted = new Set(["sweep.retag"]);
  expect(PIPE_PAUSE_POINTS.filter((point) => !fired.get(point) && !targeted.has(point))).toEqual(
    [],
  );
});

function applies(action: Action, paused: RealmName, mode: Mode, backing: Backing): boolean {
  if (action.uses.includes(paused)) return false;
  if (action.modes && !action.modes.includes(mode)) return false;
  return !action.backings || action.backings.includes(backing);
}

for (const backing of ["local", "registry"] as const)
  for (const mode of ["direct", "relay"] as const) {
    const cells = backing === "registry" ? " on registry cells" : "";
    describe(`${mode} pipe${cells}, one party paused while another runs`, () => {
      test("the workload alone stays exact", () => {
        const world = new World(mode, backing);
        workload(world);
        settle(world);
        expect(world.missedWakes).toBe(0);
        expect(world.problems).toEqual([]);
        expect(world.shared()).toBe(0);
        world.pipe.dispose();
        expect(world.registry?.cellsInUse ?? 0).toBe(0);
      });
      for (const point of PIPE_PAUSE_POINTS)
        for (const paused of ["page", "a", "b"] as const)
          test(`${paused} paused at ${point}`, () => {
            const failures: string[] = [];
            for (const action of actions) {
              if (!applies(action, paused, mode, backing)) continue;
              for (const hit of [1, 3])
                for (const failure of scenario(mode, backing, point, paused, action, hit))
                  failures.push(`${action.name} #${hit}: ${failure}`);
            }
            expect(failures).toEqual([]);
          });
    });
  }
