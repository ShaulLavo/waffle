import { expect, test } from "bun:test";
import { CompletionOwner } from "../browser/gpu/completions.ts";
import { PayloadDirectory } from "../browser/gpu/payload.ts";
import { gpuPayloadLayout as layout } from "../browser/gpu/generated/tables.ts";
import { GPU_TERMINAL } from "../browser/gpu/protocol.ts";
import { createGraphicsGuest } from "../browser/gpu/guest.ts";
import type { GraphicsOpen } from "../browser/display/protocol.ts";
import {
  createSharedControlAllocator,
  installSharedControlAllocator,
  consumedControlBytes,
} from "../memory/control.ts";
import { RecordRing } from "../browser/gpu/ring.ts";
import { ring, drain } from "./fixtures/gpu/core-fixture.ts";

function arenaRig() {
  const backing = new SharedArrayBuffer(layout.byteLength);
  const commands = ring(4096),
    replies = ring(4096, 16);
  const owner = new CompletionOwner({ commands, replies, arena: new Uint8Array(backing) });
  const directory = new PayloadDirectory(backing);
  return {
    backing,
    commands,
    replies,
    owner,
    directory,
    terminal: () => commands.terminal()?.reason,
    terminate: (candidate: number) => {
      owner.terminate(candidate);
      return commands.terminal()?.reason ?? 0;
    },
  };
}
test("payload validates capacity and data bounds before consuming; zero and tails copy once", () => {
  const rig = arenaRig();
  try {
    const payload = rig.owner.allocatePayload(new Uint8Array([1, 2, 3, 4]));
    if (!payload) throw new Error("Missing payload");
    const short = new Uint8Array(3).fill(99);
    expect(rig.directory.copyOnce(payload, short, rig.terminal, rig.terminate)).toBe(-42);
    expect(Array.from(short)).toEqual([99, 99, 99]);
    const words = new DataView(rig.backing);
    const descriptor = layout.directoryOffset + (payload.id - 1) * layout.slotBytes;
    words.setUint32(descriptor + layout.offsetOffset, 0, true);
    expect(rig.directory.copyOnce(payload, new Uint8Array(8), rig.terminal, rig.terminate)).toBe(
      -8,
    );
    words.setUint32(descriptor + layout.offsetOffset, layout.dataOffset, true);
    const output = new Uint8Array(8).fill(99);
    expect(rig.directory.copyOnce(payload, output, rig.terminal, rig.terminate)).toBe(0);
    expect(Array.from(output)).toEqual([1, 2, 3, 4, 99, 99, 99, 99]);
    expect(rig.directory.copyOnce(payload, output, rig.terminal, rig.terminate)).toBe(-8);
    const empty = rig.owner.allocatePayload(new Uint8Array());
    if (!empty) throw new Error("Missing empty payload");
    expect(empty.generation).toBe(2);
    expect(rig.directory.copyOnce(empty, new Uint8Array(), rig.terminal, rig.terminate)).toBe(0);
    expect(rig.directory.copyOnce(empty, new Uint8Array(), rig.terminal, rig.terminate)).toBe(-8);
  } finally {
    rig.owner.terminate(1);
  }
});
for (const generation of [0x7fffffff, 0x80000000, 0xffffffff])
  test(`full-width payload CAS generation ${generation}`, () => {
    const rig = arenaRig();
    try {
      rig.directory.publish(0, generation, layout.dataOffset, 0);
      expect(
        rig.directory.copyOnce(
          { id: 1, generation },
          new Uint8Array(),
          rig.terminal,
          rig.terminate,
        ),
      ).toBe(0);
      expect(rig.directory.consumed(0, generation)).toBe(true);
    } finally {
      rig.owner.terminate(1);
    }
  });
test("allocator does not trust directory offsets/lengths to free occupied credit", () => {
  const rig = arenaRig();
  try {
    const first = rig.owner.allocatePayload(new Uint8Array(64).fill(17));
    if (!first) throw new Error("Missing payload");
    const view = new DataView(rig.backing);
    view.setUint32(layout.directoryOffset + layout.offsetOffset, layout.dataOffset + 100, true);
    view.setUint32(layout.directoryOffset + layout.lengthOffset, 0, true);
    const second = rig.owner.allocatePayload(new Uint8Array(64).fill(23));
    if (!second) throw new Error("Missing second payload");
    expect(
      view.getUint32(layout.directoryOffset + layout.slotBytes + layout.offsetOffset, true),
    ).toBe(layout.dataOffset + 64);
    expect(Array.from(new Uint8Array(rig.backing, layout.dataOffset, 64))).toEqual(
      Array(64).fill(17),
    );
  } finally {
    rig.owner.terminate(1);
  }
});
for (const stage of ["before-claim", "after-claim", "after-admission"] as const)
  test(`revoke ${stage} honors the final selector admission`, () => {
    const rig = arenaRig();
    try {
      const payload = rig.owner.allocatePayload(new Uint8Array([7, 8, 9, 10]));
      if (!payload) throw new Error("Missing payload");
      const output = new Uint8Array(4).fill(99);
      let calls = 0;
      const terminal = () => {
        calls++;
        if ((stage === "before-claim" && calls === 1) || (stage === "after-claim" && calls === 2))
          rig.commands.terminate(4);
        const reason = rig.commands.terminal()?.reason;
        if (stage === "after-admission" && calls === 2) rig.commands.terminate(4);
        return reason;
      };
      expect(rig.directory.copyOnce(payload, output, terminal, rig.terminate)).toBe(
        stage === "after-admission" ? 0 : -64,
      );
      expect(Array.from(output)).toEqual(
        stage === "after-admission" ? [7, 8, 9, 10] : [99, 99, 99, 99],
      );
      expect(rig.directory.copyOnce(payload, output, rig.terminal, rig.terminate)).toBe(-64);
    } finally {
      rig.owner.terminate(1);
    }
  });
for (const first of [3, 4])
  test(`command terminal winner ${first} survives mirror lag and losing candidate`, () => {
    const rig = arenaRig();
    const other = arenaRig();
    try {
      rig.owner.publish("queue-work-result", 1, 0, { status: 1, message: "" });
      const payload = rig.owner.allocatePayload(new Uint8Array([1]));
      if (!payload) throw new Error("Missing payload");
      rig.commands.terminate(first);
      expect(new Int32Array(rig.backing)[0]).toBe(0);
      expect(rig.directory.copyOnce(payload, new Uint8Array(1), rig.terminal, rig.terminate)).toBe(
        first === 3 ? -48 : -64,
      );
      rig.owner.terminate(first === 3 ? 4 : 3);
      expect(rig.owner.state).toEqual({ kind: "terminal", reason: first });
      expect(rig.replies.terminal()?.reason).toBe(first);
      expect(new Int32Array(rig.backing)[0]).toBe(first);
      expect(drain(rig.replies).length).toBeGreaterThan(0);
      expect(other.owner.state.kind).toBe("ready");
    } finally {
      rig.owner.terminate(1);
      other.owner.terminate(1);
    }
  });
test("64 unread payload slots, oversize and fragmentation are connection-local resource pressure", () => {
  for (const mode of ["slots", "oversize", "fragmented"]) {
    const rig = arenaRig();
    try {
      if (mode === "oversize")
        rig.owner.fillPayload(layout.dataBytes + 1, () => {
          throw new Error("Must not fill");
        });
      else {
        const handles = [];
        const length = mode === "slots" ? 0 : Math.floor(layout.dataBytes / 64);
        for (let i = 0; i < 64; i++)
          handles.push(rig.owner.allocatePayload(new Uint8Array(length)));
        if (mode === "fragmented")
          for (let i = 0; i < 64; i += 2) {
            const handle = handles[i];
            if (handle)
              rig.directory.copyOnce(handle, new Uint8Array(length), rig.terminal, rig.terminate);
          }
        rig.owner.fillPayload(mode === "slots" ? 0 : length * 2, () => {
          throw new Error("Must not fill exhausted payload");
        });
      }
      expect(rig.owner.state).toEqual({ kind: "terminal", reason: 3 });
    } finally {
      rig.owner.terminate(1);
    }
  }
});
test("actual guest payload import validates both spans and snapshots an overlapping handle", () => {
  const grant = { kind: "bounded" as const, state: new SharedArrayBuffer(8), limit: 3_000_000 };
  const receipts: SharedArrayBuffer[] = [];
  const restore = installSharedControlAllocator(
    createSharedControlAllocator(grant, (buffer) => receipts.push(buffer)),
  );
  let open: GraphicsOpen | undefined;
  const channel = new MessageChannel();
  const port = {
    postMessage(message: unknown) {
      if (message && typeof message === "object" && "type" in message && message.type === "open") {
        open = message as GraphicsOpen;
        Atomics.store(new Int32Array(open.control), 0, 1);
      }
    },
    close() {},
  };
  const memory = new WebAssembly.Memory({ initial: 1 });
  const guest = createGraphicsGuest(
    {
      ...{
        port: port as unknown as MessagePort,
        gpu: true,
        revocation: new SharedArrayBuffer(64),
        surfaces: [],
        commandBytes: 4096,
        completionBytes: 4096,
      },
    },
    () => memory,
    () => {},
  );
  const invoke = (name: string, ...args: number[]) => {
    const fn = guest.imports.runtime_gpu?.[name];
    if (typeof fn !== "function") throw new Error("Missing GPU import");
    return fn(...args);
  };
  let owner: CompletionOwner | undefined;
  try {
    expect(invoke("open", 0, 0)).toBe(0);
    if (!open) throw new Error("Missing open");
    expect(receipts.map((buffer) => buffer.byteLength)).toEqual([
      64,
      4160,
      4160,
      layout.byteLength,
    ]);
    expect(consumedControlBytes(grant)).toBe(1_056_960);
    owner = new CompletionOwner({
      commands: new RecordRing(open.commands, 8),
      replies: new RecordRing(open.replies, 16),
      arena: new Uint8Array(open.arena),
    });
    const handle = owner.allocatePayload(new Uint8Array([1, 2, 3, 4]));
    if (!handle) throw new Error("Missing payload");
    const view = new DataView(memory.buffer);
    view.setUint32(64, handle.id, true);
    view.setUint32(68, handle.generation, true);
    expect(invoke("payload", 1, 64, 65537, 0)).toBe(-28);
    expect(invoke("payload", 1, 65532, 100, 4)).toBe(-28);
    expect(invoke("payload", 1, 64, 100, 3)).toBe(-42);
    expect(invoke("payload", 1, 64, 64, 8)).toBe(0);
    expect(Array.from(new Uint8Array(memory.buffer, 64, 4))).toEqual([1, 2, 3, 4]);
    view.setUint32(64, handle.id, true);
    view.setUint32(68, handle.generation, true);
    expect(invoke("payload", 1, 64, 100, 4)).toBe(-8);
  } finally {
    owner?.terminate(1);
    guest.dispose();
    restore();
    channel.port1.close();
    channel.port2.close();
  }
});
