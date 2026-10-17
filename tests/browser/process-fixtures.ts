// Original byte-encoded preview1 fixtures: no compiler, downloaded guest or dist artifact in CI.
// Handled dispositions are installed before ready\n; ordinary CPU loops remain DEFAULT.
export type ProcessFixture = "exit" | "default" | "explicit-default" | "handled" | "handled-term" | "handled-term-23" | "handled-term-143" | "handling" | "handled-trap" | "removed" | "ignored-int" | "ignored-pipe" | "handled-pipe" | "unrunnable" | "epipe" | "epipe-ignored";
export const processFixtureModes: ProcessFixture[] = ["exit", "default", "explicit-default", "handled", "handled-term", "handled-term-23", "handled-term-143", "handling", "handled-trap", "removed", "ignored-int", "ignored-pipe", "handled-pipe", "unrunnable", "epipe", "epipe-ignored"];
function uint(value: number): number[] {
  const bytes: number[] = [];
  do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return bytes;
}
function text(value: string): number[] { const bytes = Array.from(new TextEncoder().encode(value)); return uint(bytes.length).concat(bytes); }
function section(id: number, payload: number[]): number[] { return [id].concat(uint(payload.length), payload); }
function constant(value: number): number[] {
  // Signed LEB128 (all fixture addresses and statuses are positive).
  const bytes: number[] = [];
  do { const byte = value & 127; value >>= 7; const more = value !== 0 || (byte & 64) !== 0; bytes.push(byte | (more ? 128 : 0)); if (!more) break; } while (true);
  return [0x41].concat(bytes);
}
function output(iovec: number, drop = true): number[] { return constant(1).concat(constant(iovec), constant(1), constant(24), [0x10, 0], drop ? [0x1a] : []); }
function disposition(signal: number, mode: number): number[] {
  // runtime_proc.signal returns zero for a successful setter; fail visibly otherwise.
  return constant(signal).concat(constant(mode), [0x10, 3, 0x04, 0x40, 0x00, 0x0b]);
}
export function processFixture(mode: ProcessFixture): Uint8Array<ArrayBuffer> {
  const types = [5, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 1, 0x7f, 0x60, 1, 0x7f, 0, 0x60, 0, 0, 0x60, 2, 0x7f, 0x7f, 1, 0x7f];
  const imports = [5].concat(
    text("wasi_snapshot_preview1"), text("fd_write"), [0, 0],
    text(mode === "unrunnable" ? "unavailable_process_adapter" : "runtime_proc"), text("interrupted"), [0, 1],
    text("runtime_proc"), text("default_signal"), [0, 2],
    text("runtime_proc"), text("signal"), [0, 4],
    text("wasi_snapshot_preview1"), text("proc_exit"), [0, 2],
  );
  let body = [1, 1, 0x7f]; // one i32 local
  const epipe = mode === "epipe" || mode === "epipe-ignored";
  if (mode === "ignored-pipe" || mode === "epipe-ignored") body = body.concat(disposition(13, 1));
  else if (mode === "handled-pipe" || mode === "epipe") body = body.concat(disposition(13, 2));
  else if (mode === "handled-term" || mode === "handled-term-23" || mode === "handled-term-143") body = body.concat(disposition(15, 2));
  else if (mode === "ignored-int") body = body.concat(disposition(2, 1));
  else if (mode !== "default" && mode !== "exit" && mode !== "unrunnable") body = body.concat(disposition(2, 2));
  if (mode === "ignored-pipe") body = body.concat(disposition(2, 2)); // control signal proves the ignored guest remains alive
  body = body.concat(output(0, !epipe));
  if (epipe) body = body.concat(constant(64), [0x47, 0x04, 0x40, 0x00, 0x0b], constant(42), [0x10, 4]); // EPIPE => own status42
  else if (mode !== "exit" && mode !== "unrunnable") {
    body = body.concat([0x03, 0x40]); // loop
    // Exercise both spellings of the same dequeue ABI across fixtures.
    body = body.concat(mode === "handled-term-23" || mode === "handled-pipe" ? constant(0).concat(constant(0), [0x10, 3]) : [0x10, 1]);
    body = body.concat([0x22, 0, 0x04, 0x40]); // tee signal; if
    if (mode === "explicit-default") body = body.concat([0x20, 0, 0x10, 2, 0x00]); // typed default_signal trap must not return
    else if (mode === "handled-trap") body.push(0x00); // unrelated trap is not a signal outcome
    else if (mode === "handled-term-23" || mode === "handled-term-143" || mode === "handled-pipe") body = body.concat(constant(mode === "handled-term-23" ? 23 : mode === "handled-pipe" ? 42 : 143), [0x10, 4]);
    else if (mode === "handling" || mode === "removed") {
      if (mode === "removed") body = body.concat(disposition(2, 0)); // once/remove last listener restores DEFAULT before acknowledgement
      body = body.concat(output(32));
    } else body.push(0x0f); // handled signal returns normally, own status zero
    body = body.concat([0x0b, 0x0c, 0, 0x0b]); // endif; branch loop; endloop
  }
  body.push(0x0b);
  const memory = new Uint8Array(49);
  const view = new DataView(memory.buffer);
  view.setUint32(0, 8, true); view.setUint32(4, 6, true);
  memory.set(new TextEncoder().encode("ready\n"), 8);
  view.setUint32(32, 40, true); view.setUint32(36, 9, true);
  memory.set(new TextEncoder().encode("handling\n"), 40);
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, types), section(2, imports), section(3, [1, 3]), section(5, [1, 0, 1]),
    section(7, [2].concat(text("memory"), [2, 0], text("_start"), [0, 5])),
    section(10, [1].concat(uint(body.length), body)),
    section(11, [1, 0, 0x41, 0, 0x0b].concat(uint(memory.length), Array.from(memory))),
  ));
}
