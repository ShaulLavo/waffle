// Original byte-encoded generic process guests. No guest compiler or Bun WASM artifact is needed.
// The same module selects its child path by argc, allowing the real runner's executable registry
// to launch it recursively. All process I/O goes through runtime_proc, not Bun host-call slots.
export const runtimeProcChecks = [
  "generic-root-import-detection", "empty-read-is-AGAIN", "pipe-and-dup", "spawn-retains-before-parent-close",
  "poll-pipe-userdata", "inherited-dup-survives-close", "read-write-roundtrip", "last-writer-EOF",
  "poll-process-userdata", "wait-typed-status", "inherited-terminal-targets", "worker-and-filesystem-teardown",
] as const;

export const runtimeProcStages: Readonly<Record<number, string>> = {
  40: "args_sizes_get", 41: "first pipe", 42: "second pipe", 43: "dup writer", 44: "dup reader",
  45: "empty read must return AGAIN", 46: "close original writer", 47: "close original reader", 48: "spawn",
  49: "wait before completion must return AGAIN", 50: "close inherited reader in parent", 51: "close inherited writer in parent",
  52: "poll child ready", 53: "read child ready", 54: "ready byte", 55: "write ping", 56: "close last parent writer",
  57: "poll child response", 58: "read pong", 59: "response bytes", 60: "poll child EOF", 61: "read child EOF",
  62: "poll child exit", 63: "wait child result", 64: "child result kind", 65: "child result code",
  66: "close parent reader", 67: "write final marker", 68: "poll userdata", 69: "poll kind", 70: "poll flags",
  80: "child close duplicate stdout", 81: "child ready write", 82: "child poll stdin", 83: "child read ping",
  84: "child ping bytes", 85: "child poll stdin EOF", 86: "child read EOF", 87: "child close stdin",
  88: "child response write", 89: "child close last stdout alias", 90: "child inherited stdout write",
  91: "child inherited stderr write", 92: "child close inherited stdout", 93: "child close inherited stderr",
};

function uint(value: number): number[] {
  const bytes: number[] = [];
  do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return bytes;
}
function int(value: number): number[] {
  const bytes: number[] = [];
  for (;;) { const byte = value & 127; value >>= 7; const more = value !== ((byte & 64) ? -1 : 0); bytes.push(byte | (more ? 128 : 0)); if (!more) return bytes; }
}
function text(value: string): number[] { const bytes = Array.from(new TextEncoder().encode(value)); return uint(bytes.length).concat(bytes); }
function section(id: number, bytes: number[]): number[] { return [id].concat(uint(bytes.length), bytes); }
const c = (value: number) => [0x41].concat(int(value));
const get = (local: number) => [0x20].concat(uint(local));
const set = (local: number) => [0x21].concat(uint(local));
const call = (fn: number, ...args: number[][]) => args.flat().concat([0x10], uint(fn));
const load = (address: number) => c(address).concat([0x28, 2, 0]);
const store = (address: number, value: number[]) => c(address).concat(value, [0x36, 2, 0]);
const check = (value: number[], expected: number, stage: number) => value.concat(c(expected), [0x47, 0x04, 0x40], call(9, c(stage)), [0x00, 0x0b]);
const close = (fd: number[], stage: number) => check(call(8, fd), 0, stage);
const read = (fd: number[], length: number) => call(0, fd, c(4096), c(length));
const write = (fd: number[], pointer: number, length: number) => call(1, fd, c(pointer), c(length));

// Locals: 0=input reader, 1=input writer, 2=output reader, 3=output writer,
// 4=duplicated input writer, 5=duplicated output reader, 6=child pid, 7/8=JSON number scratch.
function poll(fd: number[], kind: number, stage: number, hangup = false): number[] {
  return store(256, c(kind)).concat(store(260, fd), store(264, c(12345)), store(268, c(0)),
    check(call(7, c(256), c(1), c(5000), c(512)), 1, stage),
    check(load(512), 12345, 68), check(load(516), 0, 68), check(load(520), kind, 69),
    hangup ? check(load(524), 1, 70) : []);
}
// Nonblocking readiness is not a read reservation. A relay may have queued source bytes but
// still need this reader's demand publication, and successful stream reads can be short.
// Keep every byte assertion: only AGAIN and positive short reads are retried; early EOF and any
// other errno retain the original failing stage. The browser driver bounds the full sequence.
function readExact(fd: number[], length: number, stage: number): number[] {
  return c(0).concat(set(7), [0x03, 0x40],
    call(0, fd, c(4096).concat(get(7), [0x6a]), c(length).concat(get(7), [0x6b])), set(8),
    get(8), c(-6), [0x46, 0x04, 0x40], poll(fd, 0, stage), [0x0c, 1, 0x0b],
    check(get(8).concat(c(0), [0x4c]), 0, stage),
    check(get(8).concat(c(length), get(7), [0x6b, 0x4b]), 0, stage),
    get(7), get(8), [0x6a, 0x22, 7], c(length), [0x49, 0x0d, 0, 0x0b]);
}
// JSON numbers occupy ten spaces, populated right-to-left without relying on allocated fd values.
function jsonNumber(local: number, end: number): number[] {
  return get(local).concat(set(7), c(end), set(8), [0x03, 0x40],
    get(8), get(7), c(10), [0x70], c(48), [0x6a, 0x3a, 0, 0],
    get(8), c(1), [0x6b], set(8), get(7), c(10), [0x6e, 0x22, 7, 0x0d, 0, 0x0b]);
}

export function runtimeProcFixture(): Uint8Array<ArrayBuffer> {
  const slots = { read: "@read@", write: "@write@", alias: "@alias@" };
  let request = JSON.stringify({ executable: "bun", argv: ["abi-child"], env: { PWD: "/" }, cwd: "/", job: 1,
    fds: [{ child: 0, parent: slots.read }, { child: 1, parent: slots.write }, { child: 10, parent: slots.alias },
      { child: 2, parent: 2 }, { child: 11, parent: 1 }] });
  const positions: number[] = [];
  for (const slot of Object.values(slots)) {
    const marker = JSON.stringify(slot), start = request.indexOf(marker);
    positions.push(1024 + start + 9); request = request.replace(marker, "          ");
  }
  const memory = new Uint8Array(2048), encoder = new TextEncoder();
  memory.set(encoder.encode(request), 1024);
  memory.set(encoder.encode("Rpingpongruntime-proc-ok\nchild-stdout\nchild-stderr\n"), 768);
  const spawnError = "runtime-proc-spawn-return: -0000000000\nrequest: ";
  memory.set(encoder.encode(spawnError), 840);
  const errnoEnd = 840 + spawnError.indexOf("\n") - 1;
  const parent = check(call(2, c(128)), 0, 41).concat(load(128), set(0), load(132), set(1),
    check(call(2, c(136)), 0, 42), load(136), set(2), load(140), set(3),
    call(3, get(1)), set(4), check(get(4).concat(c(0), [0x48]), 0, 43),
    call(3, get(2)), set(5), check(get(5).concat(c(0), [0x48]), 0, 44),
    check(read(get(5), 1), -6, 45), close(get(1), 46), close(get(2), 47),
    jsonNumber(0, positions[0]!), jsonNumber(3, positions[1]!), jsonNumber(3, positions[2]!),
    call(4, c(1024), c(encoder.encode(request).length)), set(6),
    // Failure-only diagnostics: preserve the original stage48 assertion and returned errno.
    get(6), c(0), [0x48, 0x04, 0x40], c(0), get(6), [0x6b], set(6), jsonNumber(6, errnoEnd),
    write(c(2), 840, encoder.encode(spawnError).length), [0x1a], write(c(2), 1024, encoder.encode(request).length), [0x1a],
    c(0), get(6), [0x6b], set(6), [0x0b], check(get(6).concat(c(0), [0x48]), 0, 48),
    check(call(5, get(6), c(640)), -6, 49), close(get(0), 50), close(get(3), 51),
    poll(get(5), 0, 52), readExact(get(5), 1, 53), check(c(4096).concat([0x2d, 0, 0]), 82, 54),
    check(write(get(4), 769, 4), 4, 55), close(get(4), 56),
    poll(get(5), 0, 57), readExact(get(5), 4, 58), check(load(4096), 0x676e6f70, 59),
    poll(get(5), 0, 60, true), check(read(get(5), 1), 0, 61), poll(get(6), 2, 62),
    check(call(5, get(6), c(640)), 0, 63), check(load(640), 0, 64), check(load(644), 23, 65),
    close(get(5), 66), check(write(c(1), 777, 16), 16, 67));
  const child = close(c(1), 80).concat(check(write(c(10), 768, 1), 1, 81), poll(c(0), 0, 82),
    readExact(c(0), 4, 83), check(load(4096), 0x676e6970, 84), poll(c(0), 0, 85, true),
    check(read(c(0), 1), 0, 86), close(c(0), 87), check(write(c(10), 773, 4), 4, 88), close(c(10), 89),
    check(write(c(11), 793, 13), 13, 90), check(write(c(2), 806, 13), 13, 91), close(c(11), 92), close(c(2), 93), call(9, c(23)));
  // argc == 1 identifies a recursively launched child; root runner supplies [bun, abi-parent].
  const body = [1, 9, 0x7f].concat(check(call(10, c(32), c(36)), 0, 40), load(32), c(1),
    [0x46, 0x04, 0x40], child, [0x05], parent, [0x0b, 0x0b]);
  const signature = (arity: number, result = true) => [0x60].concat(uint(arity), Array.from({ length: arity }, () => 0x7f), result ? [1, 0x7f] : [0]);
  const imports: [string, string, number][] = [
    ["runtime_proc", "read", 2], ["runtime_proc", "write", 2], ["runtime_proc", "pipe", 0], ["runtime_proc", "dup", 0],
    ["runtime_proc", "spawn", 1], ["runtime_proc", "wait", 1], ["runtime_proc", "job_of", 0], ["runtime_proc", "poll", 3],
    ["wasi_snapshot_preview1", "fd_close", 0], ["wasi_snapshot_preview1", "proc_exit", 4], ["wasi_snapshot_preview1", "args_sizes_get", 1],
  ];
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, [6].concat(signature(1), signature(2), signature(3), signature(4), signature(1, false), signature(0, false))),
    section(2, uint(imports.length).concat(imports.flatMap(([namespace, name, type]) => text(namespace).concat(text(name), [0], uint(type))))),
    section(3, [1, 5]), section(5, [1, 0, 1]),
    section(7, [2].concat(text("memory"), [2, 0], text("_start"), [0, imports.length])),
    section(10, [1].concat(uint(body.length), body)),
    section(11, [1, 0, 0x41, 0, 0x0b].concat(uint(memory.length), Array.from(memory))),
  ));
}
