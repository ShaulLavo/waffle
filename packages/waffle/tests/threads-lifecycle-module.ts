export function lifecycleModule(
  initial: "return" | "wait64" | "exit" | "trap" = "return",
  startSection = false,
) {
  const text = (value: string) =>
    [value.length].concat(Array.from(new TextEncoder().encode(value)));
  const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
  const imported = text("wasi_snapshot_preview1").concat(
    text("proc_exit"),
    [0, 0],
    text("fixture"),
    text("parked"),
    [0, 1],
    text("env"),
    text("memory"),
    [2, 3, 2, 2],
  );
  const returning = [0, 11];
  const exiting = [0, 65, 0, 16, 0, 11];
  const waiting = [0, 16, 1, 65, 0, 66, 0, 66, 127, 254, 2, 3, 0, 26, 11];
  const body =
    initial === "wait64"
      ? waiting
      : initial === "exit"
        ? exiting
        : initial === "trap"
          ? [0, 0, 11]
          : returning;
  const child = initial === "return" ? returning : exiting;
  const bytes = Uint8Array.from(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, [3, 96, 1, 127, 0, 96, 0, 0, 96, 2, 127, 127, 0]),
      section(2, [3].concat(imported)),
      section(3, [2, 1, 2]),
      section(7, [2].concat(text("_start"), [0, 2], text("wasi_thread_start"), [0, 3])),
      startSection ? section(8, [2]) : [],
      section(10, [2, body.length].concat(body, [child.length], child)),
    ),
  );
  return new WebAssembly.Module(bytes);
}
