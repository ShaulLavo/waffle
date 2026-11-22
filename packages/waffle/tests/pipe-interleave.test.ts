import { describe, expect, test } from "bun:test";
import { pipeSharedPagesInUse } from "../proc/pipes.js";
import { PipeRealm, PipeStreams as Streams, plainRealm } from "./fixtures/pipe-interleave.ts";

type Controller = InstanceType<PipeRealm["pipes"]["PipeController"]>;
type Endpoint = ReturnType<Controller["retain"]>;
const AGAIN = -6;

function sharedTotal(endpoint: Endpoint): number {
  const used = pipeSharedPagesInUse(endpoint.handle());
  return used.bytes + used.records;
}

describe("review round 2 reproductions", () => {
  test("an unfenced sweep paused for half the lap space never frees a live page", () => {
    const page = new PipeRealm();
    const pipe = new page.pipes.PipeController({ capacity: 8192, relay: "manual" });
    const reader = pipe.retain(1, "read");
    const victim = pipe.retain(2, "write");
    const fillers = [pipe.retain(3, "write"), pipe.retain(4, "write")];
    const trigger = pipe.retain(5, "write");
    const guestReader = plainRealm.adopt(reader),
      guestVictim = plainRealm.adopt(victim);
    // Two fillers take the shared pages writers may use, so the trigger's write scavenges.
    for (const filler of fillers) expect(filler.tryWrite([new Uint8Array(8192)])).toBe(8192);
    const buffer = new Uint8Array(8192);
    let paused = false;
    page.pause(
      "sweep.cursors",
      () => {
        paused = true;
        // While the scavenger holds the victim's old cursor, drain the fillers and run the
        // victim through half the 16-bit lap space, then leave 4 KiB unread in page 0.
        while (guestReader.tryRead([buffer]) > 0);
        const chunk = new Uint8Array(4096);
        for (let lap = 0; lap < 0x8000 * 2; lap++) {
          expect(guestVictim.tryWrite([chunk])).toBe(4096);
          expect(guestReader.tryRead([buffer])).toBe(4096);
        }
        expect(guestVictim.tryWrite([new Uint8Array(4096).fill(7)])).toBe(4096);
      },
      victim.handle().slot + 1,
    );
    trigger.tryWrite([new Uint8Array(8192)]);
    expect(paused).toBe(true);
    let live = 0;
    for (let round = 0; round < 8 && live === 0; round++) {
      const count = guestReader.tryRead([buffer]);
      if (count > 0 && buffer[0] === 7) live = count;
    }
    expect(live).toBe(4096);
  }, 30000);

  test("an unfenced sweep paused on a loaded entry across half the 16-bit lap space keeps it", () => {
    const page = new PipeRealm();
    const pipe = new page.pipes.PipeController({ capacity: 8192, relay: "manual" });
    const reader = pipe.retain(1, "read");
    // Slot 0, so the scavenger reaches this ring's live entry first.
    const victim = pipe.retain(16, "write");
    expect(victim.handle().slot).toBe(0);
    const fillers = [pipe.retain(3, "write"), pipe.retain(4, "write")];
    const trigger = pipe.retain(5, "write");
    const guestReader = plainRealm.adopt(reader),
      guestVictim = plainRealm.adopt(victim);
    expect(victim.tryWrite([new Uint8Array(4096).fill(9)])).toBe(4096);
    for (const filler of fillers) expect(filler.tryWrite([new Uint8Array(8192)])).toBe(8192);
    const buffer = new Uint8Array(8192),
      chunk = new Uint8Array(4096);
    let paused = false;
    page.pause("sweep.entry", () => {
      paused = true;
      while (guestReader.tryRead([buffer]) > 0);
      for (let lap = 0; lap < 0x8000 * 2; lap++) {
        expect(guestVictim.tryWrite([chunk])).toBe(4096);
        expect(guestReader.tryRead([buffer])).toBe(4096);
      }
      expect(guestVictim.tryWrite([new Uint8Array(4096).fill(7)])).toBe(4096);
    });
    trigger.tryWrite([new Uint8Array(8192)]);
    expect(paused).toBe(true);
    let live = 0;
    for (let round = 0; round < 8 && live === 0; round++) {
      const count = guestReader.tryRead([buffer]);
      if (count > 0 && buffer[0] === 7) live = count;
    }
    expect(live).toBe(4096);
  }, 30000);

  for (const drained of [100, 1] as const) {
    test(`a relay recovery racing a reader that drains ${drained === 100 ? "all" : "one byte"} of its delivery`, () => {
      const page = new PipeRealm();
      const pipe = new page.pipes.PipeController({ relay: "manual" });
      const host = pipe.retain(1, "read");
      const writer = pipe.retain(4, "write");
      const first = plainRealm.adopt(host.forProcess(2)),
        second = plainRealm.adopt(host.forProcess(3));
      host.close();
      expect(pipe.mode).toBe("relay");
      const streams = new Streams();
      const size = drained === 100 ? 100 : 61440;
      expect(streams.write(writer, 0, size)).toBe(size);
      expect(streams.write(writer, 0, 100)).toBe(100);
      expect(streams.take(first, size)).toBe(AGAIN);
      pipe.pumpRelay();
      expect(streams.take(second, 100)).toBe(AGAIN);
      page.pause("relay.head", () => {
        expect(streams.take(first, drained === 100 ? 100 : 1)).toBe(drained === 100 ? 100 : 1);
      });
      pipe.pumpRelay();
      expect(page.settled).toBe(true);
      for (let round = 0; round < 64 && streams.pending > 0; round++) {
        streams.take(first, 65536);
        streams.take(second, 65536);
        pipe.pumpRelay();
      }
      expect(streams.pending).toBe(0);
      first.close();
      pipe.pumpRelay();
      expect(sharedTotal(second)).toBe(0);
    });
  }

  test("a write that fails to publish wakes waiters when it returns pages", () => {
    const page = new PipeRealm();
    const pipe = new page.pipes.PipeController({ relay: "manual" });
    const reader = pipe.retain(1, "read"),
      writer = pipe.retain(2, "write");
    let observed = 0;
    page.pause("write.copied", () => {
      pipe.revoke(2);
      observed = Atomics.load(pipe.notification, 0);
    });
    expect(writer.tryWrite([new Uint8Array(65536)])).toBe(-8);
    expect(sharedTotal(reader)).toBe(0);
    expect(Atomics.load(pipe.notification, 0)).not.toBe(observed);
  });

  test("a reservation that gives back a shared record page wakes waiters", () => {
    const page = new PipeRealm();
    const pipe = new page.pipes.PipeController({ relay: "manual" });
    const reader = pipe.retain(1, "read");
    const fillers = [pipe.retain(3, "write"), pipe.retain(4, "write")];
    const writer = pipe.retain(2, "write");
    // Writers may hold 16 shared payload pages: 14 and 2 from the fillers.
    expect(fillers[0]!.tryWrite([new Uint8Array(65536)])).toBe(65536);
    expect(fillers[1]!.tryWrite([new Uint8Array(12288)])).toBe(12288);
    // 128 unread records fill the writer's reserved record pages; a 4000-byte write fills its
    // second reserved payload page.
    for (let index = 0; index < 127; index++) expect(writer.tryWrite([new Uint8Array(1)])).toBe(1);
    expect(writer.tryWrite([new Uint8Array(4000)])).toBe(4000);
    const before = pipeSharedPagesInUse(reader.handle()).records;
    let claimed = 0;
    page.pause("write.record", () => {
      claimed = pipeSharedPagesInUse(reader.handle()).records;
    });
    const observed = Atomics.load(pipe.notification, 0);
    expect(writer.tryWrite([new Uint8Array(4096)])).toBe(AGAIN);
    expect(claimed).toBe(before + 1);
    expect(pipeSharedPagesInUse(reader.handle()).records).toBe(before);
    expect(Atomics.load(pipe.notification, 0)).not.toBe(observed);
  });
});
