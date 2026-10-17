import { expect, test } from "bun:test";
import { DescriptorTable, OpenDescription, type Descriptor, type Stream } from "../core/descriptors";
import { ProcessError } from "../proc/types";
import type { WorkerDescriptorCodec } from "../proc/worker-client";
import { createRuntimeTerminalCodec } from "../browser/runtime-terminals";

const text = (value: string) => new TextEncoder().encode(value);
function terminal(): Stream {
  return { kind: "terminal", read: () => 0,
    write: chunks => chunks.reduce((count, bytes) => count + bytes.length, 0),
    readiness: () => ({ readable: true, writable: true, hangup: false }) };
}
function fixture() {
  const table = new DescriptorTable();
  for (let fd = 0; fd < 3; fd++) table.open(terminal(), (1n << 29n) - 1n, 0n);
  const output: [number, string][] = [];
  const fallback: WorkerDescriptorCodec = {
    export() { throw new Error("terminal unexpectedly delegated to fallback"); },
    import() { throw new Error("terminal token unexpectedly delegated to fallback"); },
    discard() { throw new Error("terminal token unexpectedly delegated to fallback"); },
  };
  const codec = createRuntimeTerminalCodec({ descriptors: table, fallback,
    output(fd, bytes) { output.push([fd, new TextDecoder().decode(bytes)]); } });
  return { table, codec, output, fallback };
}
function borrowed(description: OpenDescription): Descriptor {
  return { description, resource: description.resource, rightsBase: (1n << 29n) - 1n, rightsInheriting: 0n };
}

test("default runtime stdio transfers without Bun slots and routes stdout/stderr separately", () => {
  const state = fixture();
  try {
    for (const fd of [0, 1, 2]) {
      const token = state.codec.export(state.table.get(fd)!, 2);
      const resource = state.codec.import(token, 2).resource;
      expect(resource.kind).toBe("terminal");
      if (resource.kind !== "terminal") throw new Error("not terminal");
      if (fd === 0) expect(resource.read([new Uint8Array(8)])).toBe(0);
      else expect(resource.write([text(`fd${fd}`)])).toBe(3);
      state.codec.discard(token);
    }
    expect(state.output).toEqual([[1, "fd1"], [2, "fd2"]]);
  } finally { state.table.dispose(); }
});

test("terminal dup and 2>&1 inherit the original output target rather than the child binding number", () => {
  const state = fixture();
  try {
    const alias = state.table.dup(1);
    state.table.inherit(2, state.table.get(1)!);
    for (const fd of [alias, 2]) {
      const resource = state.codec.import(state.codec.export(state.table.get(fd)!, 2), 2).resource as Stream;
      expect(resource.write([text("out")])).toBe(3);
    }
    expect(state.output).toEqual([[1, "out"], [1, "out"]]);
  } finally { state.table.dispose(); }
});

test("terminal tokens keep their original target when re-exported through another guest's fd2", () => {
  const state = fixture();
  const child = new DescriptorTable();
  try {
    const imported = state.codec.import(state.codec.export(state.table.get(1)!, 2), 2);
    child.inherit(2, borrowed(imported));
    const secondOutput: [number, string][] = [];
    const second = createRuntimeTerminalCodec({ descriptors: child, fallback: state.fallback,
      output(fd, bytes) { secondOutput.push([fd, new TextDecoder().decode(bytes)]); } });
    const resource = second.import(second.export(child.get(2)!, 3), 3).resource as Stream;
    expect(resource.write([text("grandchild")])).toBe(10);
    expect(secondOutput).toEqual([[1, "grandchild"]]);
  } finally { child.dispose(); state.table.dispose(); }
});

test("unknown terminal resources fail with a guest ProcessError instead of a host TypeError", () => {
  const state = fixture();
  try {
    const unknown = state.table.open(terminal(), (1n << 29n) - 1n, 0n);
    expect(() => state.codec.export(state.table.get(unknown)!, 2)).toThrow(ProcessError);
  } finally { state.table.dispose(); }
});

test("nonterminal descriptor tokens delegate export/import/discard to the composed codec", () => {
  const description = new OpenDescription({ kind: "directory", handle: 7 });
  const token = { kind: "fixture-token" };
  const calls: string[] = [];
  const codec = createRuntimeTerminalCodec({ fallback: {
    export(value, pid) { expect(value.description).toBe(description); expect(pid).toBe(2); calls.push("export"); return token; },
    import(value, pid) { expect(value).toBe(token); expect(pid).toBe(2); calls.push("import"); return description; },
    discard(value) { expect(value).toBe(token); calls.push("discard"); },
  } });
  expect(codec.export(borrowed(description), 2)).toBe(token);
  expect(codec.import(token, 2)).toBe(description);
  codec.discard(token);
  expect(calls).toEqual(["export", "import", "discard"]);
});

for (const kind of ["terminal", "pipe"] as const) test(`terminal resolver supplies an interactive ${kind} stream, preserving provenance and one close per description`, () => {
  const state = fixture();
  const imported = new DescriptorTable();
  let closed = 0;
  const resolved: number[] = [];
  const codec = createRuntimeTerminalCodec({ fallback: state.fallback, resolveTerminal(target) {
    resolved.push(target);
    return { kind, read(chunks) { chunks[0]!.set(text("in")); return 2; },
      write: chunks => chunks.reduce((size, chunk) => size + chunk.length, 0),
      readiness: () => ({ readable: true, writable: true, hangup: false }), close() { closed++; } };
  } });
  try {
    const token = state.codec.export(state.table.get(0)!, 2);
    const description = codec.import(token, 2);
    const fd = imported.add(description, { rightsBase: 0n, rightsInheriting: 0n });
    const alias = imported.dup(fd);
    const data = new Uint8Array(2);
    expect((description.resource as Stream).read([data])).toBe(2);
    expect(new TextDecoder().decode(data)).toBe("in");
    expect((description.resource as Stream).readiness().hangup).toBe(false);
    expect(codec.export(imported.get(alias)!, 3)).toEqual({ kind: "web-terminal", target: 0 });
    imported.close(fd);
    expect(closed).toBe(0);
    imported.close(alias);
    expect(closed).toBe(1);
    expect(resolved).toEqual([0]);
  } finally { imported.dispose(); state.table.dispose(); }
});
