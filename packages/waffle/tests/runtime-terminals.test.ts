import { expect, test } from "bun:test";
import {
  DescriptorTable,
  OpenDescription,
  type Descriptor,
  type Stream,
} from "../core/descriptors";
import { ProcessError } from "../proc/types";
import type { WorkerDescriptorCodec } from "../proc/worker-client";
import { createRuntimeTerminalCodec } from "../browser/runtime-terminals";
import { deliveredTerminalOutput } from "../browser/terminal-output";
import { createNullDevice } from "../core/devices";

const text = (value: string) => new TextEncoder().encode(value);
function terminal(): Stream {
  return {
    kind: "terminal",
    read: () => 0,
    write: (chunks) => chunks.reduce((count, bytes) => count + bytes.length, 0),
    readiness: () => ({ readable: true, writable: true, hangup: false }),
  };
}
function fixture() {
  const table = new DescriptorTable();
  for (let fd = 0; fd < 3; fd++) table.open(terminal(), (1n << 29n) - 1n, 0n);
  const output: [number, string][] = [];
  const fallback: WorkerDescriptorCodec = {
    export() {
      throw new Error("terminal unexpectedly delegated to fallback");
    },
    import() {
      throw new Error("terminal token unexpectedly delegated to fallback");
    },
    discard() {
      throw new Error("terminal token unexpectedly delegated to fallback");
    },
  };
  const codec = createRuntimeTerminalCodec({
    descriptors: table,
    fallback,
    output: deliveredTerminalOutput((fd, bytes) => {
      output.push([fd, new TextDecoder().decode(bytes)]);
      return bytes.length;
    }),
  });
  return { table, codec, output, fallback };
}
function borrowed(description: OpenDescription): Descriptor {
  return {
    description,
    resource: description.resource,
    rightsBase: (1n << 29n) - 1n,
    rightsInheriting: 0n,
  };
}

test("null devices transfer without filesystem payloads or terminal provenance", () => {
  const state = fixture();
  const table = new DescriptorTable();
  try {
    const fd = table.open(createNullDevice(1), (1n << 29n) - 1n, 0n);
    const token = state.codec.export(table.get(fd)!, 2);
    expect(token).toEqual({ kind: "null-device", fdflags: 1 });
    const description = state.codec.import(token, 3);
    const resource = description.resource;
    if (resource.kind !== "device") throw Error("not a null device");
    expect(resource.fdflags).toBe(1);
    expect(resource.read([new Uint8Array(8)])).toBe(0);
    expect(resource.write([text("discarded")])).toBe(9);
    state.codec.discard(token);
  } finally {
    table.dispose();
    state.table.dispose();
  }
});

test("a stdin-only resolver keeps checked default output and EOF for declined targets", () => {
  const state = fixture();
  const imported = new DescriptorTable();
  let active = true;
  const codec = createRuntimeTerminalCodec({
    fallback: state.fallback,
    resolveTerminal: (target) => (target === 0 ? terminal() : undefined),
    output: deliveredTerminalOutput((fd, bytes) => {
      state.output.push([fd, new TextDecoder().decode(bytes)]);
      return bytes.length;
    }),
    checkActive() {
      if (!active) throw Error("revoked");
    },
  });
  try {
    for (const target of [1, 2] as const) {
      const description = codec.import({ kind: "web-terminal", target }, 2);
      const fd = imported.add(description, { rightsBase: 0n, rightsInheriting: 0n });
      const stream = imported.get(fd)!.resource;
      if (stream.kind !== "terminal") throw Error("not a terminal");
      expect(stream.tryWrite?.([text(`fd${target}`)])).toBe(3);
      expect(codec.export(imported.get(fd)!, 3)).toEqual({ kind: "web-terminal", target });
      active = false;
      expect(() => stream.write([text("blocked")])).toThrow("revoked");
      active = true;
    }
    expect(state.output).toEqual([
      [1, "fd1"],
      [2, "fd2"],
    ]);
  } finally {
    imported.dispose();
    state.table.dispose();
  }
});

test("declining stdin preserves EOF and cannot bypass revocation during resolution", () => {
  const state = fixture();
  let active = true;
  const codec = createRuntimeTerminalCodec({
    fallback: state.fallback,
    resolveTerminal: () => undefined,
    checkActive() {
      if (!active) throw Error("revoked");
    },
  });
  const table = new DescriptorTable();
  try {
    const fd = table.add(codec.import({ kind: "web-terminal", target: 0 }, 2), {
      rightsBase: 0n,
      rightsInheriting: 0n,
    });
    const stream = table.get(fd)!.resource;
    if (stream.kind !== "terminal") throw Error("not a terminal");
    expect(stream.tryRead?.([new Uint8Array(1)])).toBe(0);
    expect(stream.readiness().hangup).toBe(true);
    const revoked = createRuntimeTerminalCodec({
      fallback: state.fallback,
      resolveTerminal() {
        active = false;
        return undefined;
      },
      checkActive() {
        if (!active) throw Error("revoked");
      },
    });
    expect(() => revoked.import({ kind: "web-terminal", target: 1 }, 2)).toThrow("revoked");
  } finally {
    table.dispose();
    state.table.dispose();
  }
});

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
    expect(state.output).toEqual([
      [1, "fd1"],
      [2, "fd2"],
    ]);
  } finally {
    state.table.dispose();
  }
});

test("terminal dup and 2>&1 inherit the original output target rather than the child binding number", () => {
  const state = fixture();
  try {
    const alias = state.table.dup(1);
    state.table.inherit(2, state.table.get(1)!);
    for (const fd of [alias, 2]) {
      const resource = state.codec.import(state.codec.export(state.table.get(fd)!, 2), 2)
        .resource as Stream;
      expect(resource.write([text("out")])).toBe(3);
    }
    expect(state.output).toEqual([
      [1, "out"],
      [1, "out"],
    ]);
  } finally {
    state.table.dispose();
  }
});

test("terminal tokens keep their original target when re-exported through another guest's fd2", () => {
  const state = fixture();
  const child = new DescriptorTable();
  try {
    const imported = state.codec.import(state.codec.export(state.table.get(1)!, 2), 2);
    child.inherit(2, borrowed(imported));
    const secondOutput: [number, string][] = [];
    const second = createRuntimeTerminalCodec({
      descriptors: child,
      fallback: state.fallback,
      output: deliveredTerminalOutput((fd, bytes) => {
        secondOutput.push([fd, new TextDecoder().decode(bytes)]);
        return bytes.length;
      }),
    });
    const resource = second.import(second.export(child.get(2)!, 3), 3).resource as Stream;
    expect(resource.write([text("grandchild")])).toBe(10);
    expect(secondOutput).toEqual([[1, "grandchild"]]);
  } finally {
    child.dispose();
    state.table.dispose();
  }
});

test("unknown terminal resources fail with a guest ProcessError instead of a host TypeError", () => {
  const state = fixture();
  try {
    const unknown = state.table.open(terminal(), (1n << 29n) - 1n, 0n);
    expect(() => state.codec.export(state.table.get(unknown)!, 2)).toThrow(ProcessError);
  } finally {
    state.table.dispose();
  }
});

test("nonterminal descriptor tokens delegate export/import/discard to the composed codec", () => {
  const description = new OpenDescription({ kind: "directory", handle: 7 });
  const token = { kind: "fixture-token" };
  const calls: string[] = [];
  const codec = createRuntimeTerminalCodec({
    fallback: {
      export(value, pid) {
        expect(value.description).toBe(description);
        expect(pid).toBe(2);
        calls.push("export");
        return token;
      },
      import(value, pid) {
        expect(value).toBe(token);
        expect(pid).toBe(2);
        calls.push("import");
        return description;
      },
      discard(value) {
        expect(value).toBe(token);
        calls.push("discard");
      },
    },
  });
  expect(codec.export(borrowed(description), 2)).toBe(token);
  expect(codec.import(token, 2)).toBe(description);
  codec.discard(token);
  expect(calls).toEqual(["export", "import", "discard"]);
});

for (const kind of ["terminal", "pipe"] as const)
  test(`terminal resolver supplies an interactive ${kind} stream, preserving provenance and one close per description`, () => {
    const state = fixture();
    const imported = new DescriptorTable();
    let closed = 0;
    const resolved: number[] = [];
    const codec = createRuntimeTerminalCodec({
      fallback: state.fallback,
      resolveTerminal(target) {
        resolved.push(target);
        return {
          kind,
          read(chunks) {
            chunks[0]!.set(text("in"));
            return 2;
          },
          write: (chunks) => chunks.reduce((size, chunk) => size + chunk.length, 0),
          readiness: () => ({ readable: true, writable: true, hangup: false }),
          close() {
            closed++;
          },
        };
      },
    });
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
    } finally {
      imported.dispose();
      state.table.dispose();
    }
  });

for (const cause of ["fatal outcome", "filesystem revocation"] as const)
  test(`resolved endpoint stops every admission operation after ${cause}, preserving cleanup and provenance`, () => {
    let active = true,
      calls = 0,
      closed = 0;
    class Endpoint implements Stream {
      readonly kind = "pipe";
      #value = 7;
      read() {
        calls++;
        return this.#value;
      }
      write() {
        calls++;
        return this.#value;
      }
      tryRead() {
        calls++;
        return this.#value;
      }
      tryWrite() {
        calls++;
        return this.#value;
      }
      readiness() {
        calls++;
        return { readable: true, writable: true, hangup: false };
      }
      forProcess() {
        calls++;
        return new Endpoint();
      }
      close() {
        closed++;
      }
    }
    const codec = createRuntimeTerminalCodec({
      fallback: {
        export() {
          throw new Error("unexpected fallback");
        },
        import() {
          throw new Error("unexpected fallback");
        },
        discard() {
          throw new Error("unexpected fallback");
        },
      },
      resolveTerminal: () => new Endpoint(),
      checkActive() {
        if (!active) throw new Error(cause);
      },
    });
    const description = codec.import({ kind: "web-terminal", target: 0 }, 2);
    const table = new DescriptorTable();
    const fd = table.add(description, { rightsBase: 0n, rightsInheriting: 0n });
    try {
      const stream = description.resource as Stream;
      expect(stream.read([])).toBe(7);
      const child = stream.forProcess!(3);
      expect(codec.export(borrowed(new OpenDescription(child)), 4)).toEqual({
        kind: "web-terminal",
        target: 0,
      });
      child.close!();
      calls = 0;
      active = false;
      for (const operation of [
        () => stream.read([]),
        () => stream.write([]),
        () => stream.tryRead!([]),
        () => stream.tryWrite!([]),
        () => stream.readiness(),
        () => stream.forProcess!(3),
      ])
        expect(operation).toThrow(cause);
      expect(calls).toBe(0);
      table.close(fd);
      expect(closed).toBe(2);
    } finally {
      table.dispose();
    }
  });

for (const operation of ["read", "close"] as const)
  test(`frozen resolved streams preserve own ${operation} methods without proxy invariant errors`, () => {
    let active = true,
      closed = 0;
    const endpoint = Object.freeze({
      kind: "pipe" as const,
      read() {
        expect(this).toBe(endpoint);
        return 7;
      },
      write() {
        expect(this).toBe(endpoint);
        return 7;
      },
      readiness() {
        return { readable: true, writable: true, hangup: false };
      },
      close() {
        expect(this).toBe(endpoint);
        closed++;
      },
    });
    const codec = createRuntimeTerminalCodec({
      fallback: {
        export() {
          throw new Error("unexpected fallback");
        },
        import() {
          throw new Error("unexpected fallback");
        },
        discard() {
          throw new Error("unexpected fallback");
        },
      },
      resolveTerminal: () => endpoint,
      checkActive() {
        if (!active) throw new Error("revoked");
      },
    });
    const table = new DescriptorTable();
    const description = codec.import({ kind: "web-terminal", target: 0 }, 2);
    const fd = table.add(description, { rightsBase: 0n, rightsInheriting: 0n });
    try {
      const stream = description.resource as Stream;
      if (operation === "read") {
        expect(stream.read([])).toBe(7);
        active = false;
        expect(() => stream.read([])).toThrow("revoked");
      } else active = false;
      table.close(fd);
      expect(closed).toBe(1);
    } finally {
      try {
        table.dispose();
      } finally {
        if (!closed) endpoint.close();
      }
    }
  });

test("resolver causal control distinguishes active empty input from the default terminal EOF", () => {
  const state = fixture();
  const token = state.codec.export(state.table.get(0)!, 2);
  const defaultStream = state.codec.import(token, 2).resource as Stream;
  try {
    expect(defaultStream.tryRead!([new Uint8Array(1)])).toBe(0);
    expect(defaultStream.readiness().hangup).toBe(true);
    const codec = createRuntimeTerminalCodec({
      fallback: state.fallback,
      resolveTerminal: () => ({
        kind: "terminal",
        read: () => -6,
        tryRead: () => -6,
        write: () => -8,
        readiness: () => ({ readable: false, writable: true, hangup: false }),
      }),
    });
    const live = codec.import(token, 2).resource as Stream;
    expect(live.tryRead!([new Uint8Array(1)])).toBe(-6);
    expect(live.readiness()).toEqual({ readable: false, writable: true, hangup: false });
  } finally {
    state.table.dispose();
  }
});
