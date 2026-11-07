import { expect, test } from "bun:test";
import { gpuObjectKinds } from "../browser/gpu/generated/tables.ts";
import { objectKind } from "../browser/gpu/handles.ts";
import { GPU_TERMINAL } from "../browser/gpu/protocol.ts";
import {
  command,
  drain,
  encodeBlob,
  handle,
  joinRecords,
  RecordingTarget,
  rig,
  send,
  words,
} from "./fixtures/gpu/core-fixture.ts";
import expected from "./fixtures/gpu/label-expected.json";

type Connection = ReturnType<typeof rig>["connection"];
function bind(connection: Connection, kind: string, value: object, id = 7) {
  const table = connection.replay.handles;
  table.reserve(handle(id), objectKind(kind));
  table.bind(handle(id), objectKind(kind), { kind: "native", value });
}
function passDescriptor() {
  return {
    next_in_chain: [],
    label: "",
    color_attachments: [],
    depth_stencil_attachment: null,
    occlusion_query_set: null,
    timestamp_writes: null,
  };
}
function labelRecords(name: string, labels: readonly string[]) {
  const nested = name === "command_encoder.set_label" || name === "render_pass_encoder.set_label";
  return labels.map((label) => command(name, nested ? { label } : { receiver: handle(7), label }));
}
function mutate(connection: Connection, name: string, labels: readonly string[]) {
  const records = labelRecords(name, labels);
  if (name === "command_encoder.set_label") {
    send(connection, encodeBlob(7, joinRecords(...records)));
    return;
  }
  if (name === "render_pass_encoder.set_label") {
    send(
      connection,
      encodeBlob(
        6,
        joinRecords(
          command("command_encoder.begin_render_pass", {
            result: handle(7),
            descriptor: passDescriptor(),
          }),
          ...records,
          command("render_pass_encoder.end", {}),
        ),
      ),
    );
    return;
  }
  send(connection, joinRecords(...records));
}

for (const vector of expected.vectors) {
  test(`ordered label assignment preserves identity: ${vector.command}`, () => {
    const target = new RecordingTarget();
    const { connection, replies, credit } = rig(target, 4096);
    const kind = vector.command.split(".")[0]!;
    const seen: { receiver: object; value: unknown }[] = [];
    const native = kind === "render_pass_encoder" ? target.pass : {};
    Object.defineProperty(native, "label", {
      configurable: true,
      set(this: object, value: unknown) {
        seen.push({ receiver: this, value });
      },
    });
    try {
      if (kind === "render_pass_encoder") bind(connection, "command_encoder", target.encoder, 6);
      else bind(connection, kind, native);
      mutate(connection, vector.command, ["first", "λ猫", ""]);
      expect(connection.state.kind).toBe("ready");
      if (kind === "surface") {
        expect(seen).toEqual([]);
        expect(Reflect.get(native, "label")).toBe("");
      } else
        expect(seen).toEqual(["first", "λ猫", ""].map((value) => ({ receiver: native, value })));
      expect(connection.replay.handles.native(handle(7), objectKind(kind))).toBe(native);
      expect(drain(replies)).toEqual([]);
      send(connection, words(0x1000, [gpuObjectKinds[objectKind(kind)], 7, 1]));
      expect(() => connection.replay.handles.get(handle(7), objectKind(kind))).toThrow("released");
    } finally {
      connection.close();
    }
    expect(credit.used).toBe(0);
  });
}

for (const vector of expected.vectors.filter((vector) => vector.context === "top")) {
  for (const fault of ["wrong-kind", "stale", "released"] as const) {
    test(`${vector.command} rejects ${fault} locally and leaves another connection unchanged`, () => {
      const first = rig({ root: {} });
      const second = rig({ root: {} });
      const kind = objectKind(vector.command.split(".")[0]!);
      const native = { label: "unchanged" };
      const other = { label: "other" };
      try {
        bind(first.connection, fault === "wrong-kind" ? "adapter" : kind, native);
        bind(second.connection, kind, other);
        if (fault === "released") first.connection.replay.handles.release(handle(7), kind);
        send(
          first.connection,
          command(vector.command, {
            receiver: handle(7, fault === "stale" ? 2 : 1),
            label: "bad",
          }),
        );
        expect(first.connection.state).toMatchObject({
          kind: "terminal",
          reason: GPU_TERMINAL.protocol,
        });
        expect(native.label).toBe("unchanged");
        send(
          second.connection,
          command(vector.command, { receiver: handle(7), label: "survived" }),
        );
        expect(second.connection.state.kind).toBe("ready");
        expect(other.label).toBe("survived");
        second.connection.close();
        expect(() => second.connection.replay.handles.native(handle(7), kind)).toThrow();
      } finally {
        first.connection.close();
        second.connection.close();
      }
      expect(first.credit.used + second.credit.used).toBe(0);
    });
  }
}

test("invalid native identities remain labelable, exception placeholders remain exceptions", () => {
  const { connection, replies } = rig({ root: {} });
  const invalid = { label: "invalid", invalid: true };
  try {
    bind(connection, "buffer", invalid);
    send(connection, command("buffer.set_label", { receiver: handle(7), label: "still-invalid" }));
    expect(invalid).toEqual({ label: "still-invalid", invalid: true });
    expect(connection.replay.handles.get(handle(7), "buffer")).toMatchObject({
      kind: "native",
      value: invalid,
    });
    connection.replay.handles.reserve(handle(8), "buffer");
    connection.replay.handles.bind(handle(8), "buffer", {
      kind: "exception",
      message: "creation threw",
    });
    send(connection, command("buffer.set_label", { receiver: handle(8), label: "not-native" }));
    expect(connection.replay.handles.get(handle(8), "buffer")).toMatchObject({
      kind: "exception",
      message: "creation threw",
    });
    expect(connection.state.kind).toBe("ready");
    const exceptions = drain(replies);
    expect(exceptions).toHaveLength(1);
    expect(new DataView(exceptions[0]!.buffer).getUint16(0, true)).toBe(8);
  } finally {
    connection.close();
  }
});

for (const fault of ["throw", "false"] as const) {
  test(`native label setter ${fault} reports a call exception without poisoning the next label`, () => {
    const { connection, replies } = rig({ root: {} });
    const target =
      fault === "false"
        ? Object.freeze({ label: "frozen" })
        : {
            set label(_value: string) {
              throw new TypeError("setter rejected");
            },
          };
    const next = { label: "before" };
    try {
      bind(connection, "buffer", target);
      bind(connection, "queue", next, 8);
      send(
        connection,
        joinRecords(
          command("buffer.set_label", { receiver: handle(7), label: "rejected" }),
          command("queue.set_label", { receiver: handle(8), label: "after" }),
        ),
      );
      expect(connection.state.kind).toBe("ready");
      expect(next.label).toBe("after");
      expect(drain(replies)).toHaveLength(1);
      expect(connection.replay.handles.native(handle(7), "buffer")).toBe(target);
    } finally {
      connection.close();
    }
  });
}

for (const name of ["command_encoder.set_label", "render_pass_encoder.set_label"]) {
  test(`nested ${name} is rejected outside its encoder/pass context`, () => {
    const { connection } = rig({ root: {} });
    try {
      send(connection, command(name, { label: "wrong-context" }));
      expect(connection.state).toMatchObject({ kind: "terminal", reason: GPU_TERMINAL.protocol });
    } finally {
      connection.close();
    }
  });
}

test("surface label replaces only the reference's own property and never invokes page authority", () => {
  const canvas = Object.freeze({ label: "canvas", width: 64, height: 64 });
  const context = Object.freeze({ label: "context" });
  const device = Object.freeze({ label: "device" });
  const reference = Object.create({
    set label(_value: string) {
      throw new Error("inherited canvas authority setter invoked");
    },
  });
  Object.assign(reference, { canvas, context, device });
  const { connection, replies } = rig({ root: {} });
  try {
    bind(connection, "surface", reference);
    mutate(connection, "surface.set_label", ["virtual"]);
    expect(Reflect.get(reference, "label")).toBe("virtual");
    expect(canvas).toEqual({ label: "canvas", width: 64, height: 64 });
    expect(context.label).toBe("context");
    expect(device.label).toBe("device");
    expect(drain(replies)).toEqual([]);
  } finally {
    connection.close();
  }
});

test("created surface keeps its initial label and later labels on its own reference only", () => {
  const surface = { visible: Object.freeze({ label: "page" }) };
  const released: object[] = [];
  const { connection, replies } = rig({
    root: {},
    surfaces: {
      create: () => surface,
      configure() {
        throw new Error("unexpected configure");
      },
      acquire() {
        throw new Error("unexpected acquire");
      },
      present() {
        throw new Error("unexpected present");
      },
      unconfigure() {
        throw new Error("unexpected unconfigure");
      },
      release(value) {
        released.push(value);
      },
    },
  });
  try {
    send(
      connection,
      command("instance.create_surface", {
        result: handle(7),
        receiver: handle(1),
        descriptor: {
          next_in_chain: [{ sType: 4096, value: { surface_id: 7 } }],
          label: "initial",
        },
      }),
    );
    expect(Reflect.get(surface, "label")).toBe("initial");
    mutate(connection, "surface.set_label", ["next", ""]);
    expect(Reflect.get(surface, "label")).toBe("");
    expect(surface.visible.label).toBe("page");
    send(connection, words(0x1000, [gpuObjectKinds.surface, 7, 1]));
    expect(released).toEqual([surface]);
    expect(drain(replies)).toEqual([]);
  } finally {
    connection.close();
  }
  expect(released).toEqual([surface]);
});

test("render-pass labels reject a compute pass instead of relabeling the active encoder", () => {
  const pass = { label: "compute", end() {} };
  const encoder = { label: "encoder", beginComputePass: () => pass };
  const { connection } = rig({ root: {} });
  try {
    bind(connection, "command_encoder", encoder, 6);
    send(
      connection,
      encodeBlob(
        6,
        joinRecords(
          command("command_encoder.begin_compute_pass", { result: handle(7), descriptor: null }),
          command("render_pass_encoder.set_label", { label: "wrong" }),
        ),
      ),
    );
    expect(connection.state).toMatchObject({ kind: "terminal", reason: GPU_TERMINAL.protocol });
    expect(pass.label).toBe("compute");
    expect(encoder.label).toBe("encoder");
  } finally {
    connection.close();
  }
});
