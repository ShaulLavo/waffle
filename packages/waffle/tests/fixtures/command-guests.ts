import wabt from "wabt";

const exit = '(import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))';
const io = `
  (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1 1)
`;
const imports = `
  (import "wasi_snapshot_preview1" "fd_read" (func $read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close" (func $close (param i32) (result i32)))
  (import "runtime_proc" "signal" (func $signal (param i32 i32) (result i32)))
`;

const emit = `
  (func $emit (param $fd i32) (param $ptr i32) (param $length i32)
    (loop $again
      (i32.store (i32.const 0) (local.get $ptr))
      (i32.store (i32.const 4) (local.get $length))
      (if (call $write (local.get $fd) (i32.const 0) (i32.const 1) (i32.const 8))
        (then unreachable))
      (local.set $ptr (i32.add (local.get $ptr) (i32.load (i32.const 8))))
      (local.set $length (i32.sub (local.get $length) (i32.load (i32.const 8))))
      (br_if $again (local.get $length))))
`;
function data(value: string) {
  return Array.from(
    new TextEncoder().encode(value),
    (byte) => "\\" + byte.toString(16).padStart(2, "0"),
  ).join("");
}

const open = '(func (export "_start")';
const close = "))";
const files = {
  exit130: `(module ${exit} (memory (export "memory") 1 1) ${open} (call $exit (i32.const 130)) ${close}`,
  tee: `(module ${imports} ${io} ${emit} ${open} (local $count i32)
    (loop $again
      (i32.store (i32.const 0) (i32.const 32))
      (i32.store (i32.const 4) (i32.const 16384))
      (if (call $read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 8)) (then unreachable))
      (local.set $count (i32.load (i32.const 8)))
      (if (local.get $count)
        (then
          (call $emit (i32.const 1) (i32.const 32) (local.get $count))
          (call $emit (i32.const 2) (i32.const 32) (local.get $count))
          (br $again)))) ${close}`,
  "closed-output": `(module ${io} ${emit}
    (data (i32.const 32) "stderr")
    ${open}
    (i32.store (i32.const 0) (i32.const 32))
    (i32.store (i32.const 4) (i32.const 6))
    (if (i32.ne (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)) (i32.const 8))
      (then unreachable))
    (call $emit (i32.const 2) (i32.const 32) (i32.const 6)) ${close}`,
  "close-input": `(module ${imports} ${io} ${emit}
    (data (i32.const 32) "closed")
    ${open}
    (if (call $close (i32.const 0)) (then unreachable))
    (call $emit (i32.const 1) (i32.const 32) (i32.const 6))
    (loop $live (drop (call $signal (i32.const 0) (i32.const 4))) (br $live)) ${close}`,
  live: `(module ${imports} ${io} ${emit}
    (data (i32.const 32) "live")
    ${open}
    (call $emit (i32.const 1) (i32.const 32) (i32.const 4))
    (loop $live (drop (call $signal (i32.const 0) (i32.const 4))) (br $live)) ${close}`,
  "sigint-twice": `(module ${imports} ${io} ${emit}
    (data (i32.const 32) "readyhandled")
    ${open}
    (if (call $signal (i32.const 2) (i32.const 2)) (then unreachable))
    (call $emit (i32.const 1) (i32.const 32) (i32.const 5))
    (loop $wait
      (br_if $wait (i32.eqz (call $signal (i32.const 0) (i32.const 0)))))
    (if (call $signal (i32.const 2) (i32.const 0)) (then unreachable))
    (call $emit (i32.const 1) (i32.const 37) (i32.const 7))
    (loop $live (drop (call $signal (i32.const 0) (i32.const 4))) (br $live)) ${close}`,
};

function request(executable: string, operation: "spawn" | "exec") {
  return JSON.stringify({
    executable,
    argv: [executable],
    env: {},
    cwd: "/",
    ...(operation === "spawn" ? { job: -1 } : {}),
    fds: [{ child: 1, parent: 1 }],
  });
}

function processGuest(
  operation: "spawn" | "exec",
  executable: string,
  expected: "success" | "error",
) {
  const json = request(executable, operation);
  const perform = `(call $perform (i32.const 32) (i32.const ${json.length}))`;
  let body = `(if (i32.ge_s ${perform} (i32.const 0)) (then unreachable))`;
  if (expected === "success") {
    body =
      operation === "spawn"
        ? `(if (i32.le_s ${perform} (i32.const 0)) (then unreachable))`
        : `(drop ${perform}) unreachable`;
  }
  return `(module (import "runtime_proc" "${operation}" (func $perform (param i32 i32) (result i32)))
    ${io}
    (data (i32.const 32) "${data(json)}")
    ${open} ${body} ${close}`;
}

/** Starts a child that never exits on its own, then ends with a status of its own. */
function leaderGuest(child: string, code: number) {
  const json = request(child, "spawn");
  return `(module (import "runtime_proc" "spawn" (func $spawn (param i32 i32) (result i32)))
    ${exit} ${io}
    (data (i32.const 32) "${data(json)}")
    ${open}
    (if (i32.le_s (call $spawn (i32.const 32) (i32.const ${json.length})) (i32.const 0))
      (then unreachable))
    (call $exit (i32.const ${code})) ${close}`;
}

export async function compileCommandGuests(): Promise<Map<string, Uint8Array>> {
  const compiler = await wabt();
  const cases = {
    ...files,
    "leader-exit7": leaderGuest("/test/live", 7),
    "spawn-child": processGuest("spawn", "/test/exit130", "success"),
    "spawn-disallowed": processGuest("spawn", "/test/script", "success"),
    "exec-disallowed": processGuest("exec", "/test/script", "error"),
    "exec-child": processGuest("exec", "/test/exit130", "success"),
  };
  const result = new Map<string, Uint8Array>();
  for (const [name, wat] of Object.entries(cases)) {
    const module = compiler.parseWat(name, wat);
    try {
      result.set(name, module.toBinary({}).buffer);
    } finally {
      module.destroy();
    }
  }
  return result;
}
