import { validGraphicsOpen } from "../browser/display/open.ts";
import { expect, test } from "bun:test";
import { CompletionOwner } from "../browser/gpu/completions.ts";
import { PayloadDirectory } from "../browser/gpu/payload.ts";
import { gpuPayloadLayout as layout } from "../browser/display/generated/graphics-layout.ts";
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
function exhaustPayload(rig: ReturnType<typeof arenaRig>, mode: string): void {
  const length = mode === "slots" ? 0 : Math.floor(layout.dataBytes / 64);
  const handles = Array.from({ length: 64 }, () =>
    rig.owner.allocatePayload(new Uint8Array(length)),
  );
  if (mode === "fragmented") consumeAlternating(rig, handles, length);
  rig.owner.fillPayload(mode === "slots" ? 0 : length * 2, () => {
    throw new Error("Must not fill exhausted payload");
  });
}
function consumeAlternating(
  rig: ReturnType<typeof arenaRig>,
  handles: readonly ({ id: number; generation: number } | undefined)[],
  length: number,
): void {
  for (let index = 0; index < handles.length; index += 2) {
    const handle = handles[index];
    if (handle) rig.directory.copyOnce(handle, new Uint8Array(length), rig.terminal, rig.terminate);
  }
}
for (const mode of ["slots", "oversize", "fragmented"])
  test(`payload pressure ${mode} closes locally`, () => {
    const rig = arenaRig();
    try {
      if (mode === "oversize")
        rig.owner.fillPayload(layout.dataBytes + 1, () => {
          throw new Error("Must not fill");
        });
      else exhaustPayload(rig, mode);
      expect(rig.owner.state).toEqual({ kind: "terminal", reason: 3 });
    } finally {
      rig.owner.terminate(1);
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
  const port = channel.port1;
  port.postMessage = (message: unknown) => {
    if (!validGraphicsOpen(message, 4096, 4096)) return;
    open = message;
    Atomics.store(new Int32Array(open.control), 0, 1);
  };
  const memory = new WebAssembly.Memory({ initial: 1 });
  const guest = createGraphicsGuest(
    {
      port,
      gpu: true,
      revocation: new SharedArrayBuffer(64),
      surfaces: [],
      commandBytes: 4096,
      completionBytes: 4096,
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

test("unexpected service payload fill exceptions are not fabricated resource exhaustion", () => {
  const rig = arenaRig();
  try {
    expect(
      rig.owner.fillPayload(4, () => {
        throw new TypeError("native adaptation failure");
      }),
    ).toBeUndefined();
    expect(rig.owner.state).toEqual({ kind: "terminal", reason: 5 });
    expect(rig.owner.failure).toBe("native adaptation failure");
  } finally {
    rig.owner.terminate(1);
  }
});

for (const mode of ["winning-unsupported", "winning-invalid", "post-resource"] as const)
  test(`actual open import preserves ${mode} terminal errno`, () => {
    const grant = { kind: "bounded" as const, state: new SharedArrayBuffer(8), limit: 1_056_960 };
    const receipts: SharedArrayBuffer[] = [];
    const restore = installSharedControlAllocator(
      createSharedControlAllocator(grant, (buffer) => receipts.push(buffer)),
    );
    const channel = new MessageChannel(),
      revocation = new SharedArrayBuffer(64);
    let opened: GraphicsOpen | undefined;
    channel.port1.postMessage = (message: unknown) => {
      if (!validGraphicsOpen(message, 4096, 4096)) return;
      opened = message;
      if (mode !== "post-resource") return;
      new RecordRing(message.commands, 8).terminate(3);
      throw new Error("post failed after resource selection");
    };
    let selected = false;
    const memory = new WebAssembly.Memory({ initial: 1 });
    const output = new DataView(memory.buffer);
    output.setUint32(0, 0xaabbccdd, true);
    const guest = createGraphicsGuest(
      {
        port: channel.port1,
        gpu: true,
        revocation,
        surfaces: [],
        commandBytes: 4096,
        completionBytes: 4096,
      },
      () => memory,
      () => {
        if (!opened || selected || mode === "post-resource") return;
        selected = true;
        const reason = mode === "winning-invalid" ? 2 : 5;
        new RecordRing(opened.commands, 8).terminate(reason);
        const control = new Int32Array(opened.control);
        Atomics.store(control, 1, reason);
        Atomics.store(control, 0, mode === "winning-invalid" ? -28 : -58);
        Atomics.store(new Int32Array(revocation), 0, 1);
      },
    );
    try {
      const open = guest.imports.runtime_gpu?.open;
      if (typeof open !== "function") throw new Error("Missing open import");
      expect(open(0, 0)).toBe(
        mode === "post-resource" ? -48 : mode === "winning-invalid" ? -28 : -58,
      );
      expect(output.getUint32(0, true)).toBe(0xaabbccdd);
      expect(receipts.map((buffer) => buffer.byteLength)).toEqual([
        64,
        4160,
        4160,
        layout.byteLength,
      ]);
      expect(consumedControlBytes(grant)).toBe(1_056_960);
    } finally {
      guest.dispose();
      channel.port2.close();
      restore();
    }
  });

test("payload copy failure after admission quarantines reading rather than consuming", () => {
  const rig = arenaRig();
  try {
    const handle = rig.owner.allocatePayload(new Uint8Array([1, 2, 3, 4]));
    if (!handle) throw new Error("Missing payload");
    const buffer = new ArrayBuffer(4),
      destination = new Uint8Array(buffer);
    let loads = 0;
    const terminal = () => {
      if (++loads === 2) structuredClone(buffer, { transfer: [buffer] });
      return undefined;
    };
    expect(rig.directory.copyOnce(handle, destination, terminal, rig.terminate)).toBe(-64);
    expect(rig.directory.state(handle.id - 1) & 0xffffffffn).toBe(BigInt(layout.reading));
    expect(rig.owner.state).toEqual({ kind: "terminal", reason: 5 });
  } finally {
    rig.owner.terminate(1);
  }
});
test("equal-valued payload handles belong to their supplied connection domains", () => {
  const first = arenaRig(),
    second = arenaRig();
  try {
    const a = first.owner.allocatePayload(new Uint8Array([1])),
      b = second.owner.allocatePayload(new Uint8Array([2]));
    if (!a || !b) throw new Error("Missing domain payload");
    expect(a).toEqual(b);
    const output = new Uint8Array(1);
    expect(second.directory.copyOnce(a, output, second.terminal, second.terminate)).toBe(0);
    expect(output[0]).toBe(2);
    expect(first.directory.copyOnce(b, output, first.terminal, first.terminate)).toBe(0);
    expect(output[0]).toBe(1);
  } finally {
    first.owner.terminate(1);
    second.owner.terminate(1);
  }
});
