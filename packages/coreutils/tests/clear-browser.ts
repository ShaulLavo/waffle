import { createRuntime } from "waffle";
import { GhosttyRuntime } from "ghostty-webgpu";
import { createShell, type Shell } from "../src/shell.ts";
import {
  installClear,
  UtilityConflictError,
  type UtilityInstallation,
} from "bash-web/utilities/clear";

const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: "/fs-worker.js" } });
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let shell: Shell | undefined;
let installation: UtilityInstallation | undefined;
let terminalRuntime: GhosttyRuntime | undefined;
let loads = 0;
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function run(script: string) {
  const current = await createShell({
    runtime,
    script,
    wasmUrl: "/shell-runtime.wasm",
    workerUrl: "/shell-worker.js",
    env: { PATH: "/bin", TERM: "xterm-256color" },
  });
  shell = current;
  let bytes: number[] = [];
  const drain = () => {
    bytes = bytes.concat(Array.from(current.terminal.drain()));
  };
  const timer = setInterval(drain, 2);
  try {
    const exit = await current.done;
    drain();
    return {
      status: exit.code,
      bytes: Uint8Array.from(bytes),
      text: decoder.decode(Uint8Array.from(bytes)),
    };
  } finally {
    clearInterval(timer);
    await current.dispose();
    check(current.diagnostics().roots.length === 0, "shell retained runtime roots");
    shell = undefined;
  }
}
async function conflict() {
  try {
    await installClear(runtime);
  } catch (error) {
    check(error instanceof UtilityConflictError, `wrong conflict: ${String(error)}`);
    return;
  }
  throw new Error("expected clear installation conflict");
}
function screen(bytes: Uint8Array, keep: boolean) {
  check(terminalRuntime, "terminal runtime absent");
  const terminal = terminalRuntime.createTerminal({ columns: 20, rows: 4 });
  try {
    terminal.write(Array.from({ length: 12 }, (_, index) => `old${index}\r\n`).join(""));
    const history = terminal.scrollbackLength;
    check(history > 0, "fixture did not create scrollback");
    terminal.write(bytes);
    check(terminal.cursor.x === 0 && terminal.cursor.y === 0, "cursor was not homed");
    const visible = terminal.readLines(terminal.scrollbackLength, terminal.lineCount());
    check(
      visible.every((line) => line.text === ""),
      `display not empty: ${JSON.stringify(visible)}`,
    );
    check(terminal.scrollbackLength === (keep ? history : 0), "incorrect scrollback behavior");
    terminal.write("next");
    check(
      terminal.readLines(terminal.scrollbackLength, terminal.scrollbackLength + 1)[0]?.text ===
        "next",
      "next prompt is not at home",
    );
  } finally {
    terminal.dispose();
  }
}
async function main() {
  check((await run("clear")).status === 127, "uninstalled clear must be missing");
  await runtime.filesystem.writeFile("/bin/clear", encoder.encode("foreign"));
  await conflict();
  check(
    decoder.decode(await runtime.filesystem.readFile("/bin/clear")) === "foreign",
    "foreign entry changed",
  );
  await runtime.filesystem.remove("/bin/clear");
  installation = await installClear(runtime, {
    workerUrl: "/shell-worker.js",
    source: async () => {
      loads++;
      return new Uint8Array(await (await fetch("/clear.wasm")).arrayBuffer());
    },
  });
  check(loads === 0, "install loaded the guest");
  await conflict();
  const keep = await run("clear -x");
  check(keep.status === 0 && keep.text === "\x1b[H\x1b[2J", "wrong -x bytes/status");
  const clear = await run("clear");
  check(clear.status === 0 && clear.text === "\x1b[H\x1b[2J\x1b[3J", "wrong clear bytes/status");
  check(Number(loads) === 1, "guest was not loaded lazily once");
  terminalRuntime = await GhosttyRuntime.create({
    wasm: "/ghostty-vt.wasm",
    bridge: "/bridge.wasm",
  });
  screen(keep.bytes, true);
  screen(clear.bytes, false);
  const rejected = await run("clear -x --bad 2>/error");
  check(
    rejected.status === 1 && rejected.bytes.length === 0,
    "invalid option emitted output or succeeded",
  );
  check(
    decoder.decode(await runtime.filesystem.readFile("/error")).includes("usage"),
    "missing option diagnostic",
  );
  const unknown = await run("TERM=dumb clear 2>/error");
  check(unknown.status === 1 && unknown.bytes.length === 0, "unknown terminal succeeded");
  const redirect = await run("clear -T xterm -x >/out");
  check(redirect.status === 0 && redirect.bytes.length === 0, "redirect leaked terminal bytes");
  check(
    decoder.decode(await runtime.filesystem.readFile("/out")) === keep.text,
    "redirect changed bytes",
  );
  await installation.dispose();
  await installation.dispose();
  check(!(await runtime.filesystem.lookup("/bin/clear")), "owned marker remains");
  check(
    !runtime.disposed && (await run("printf alive")).text === "alive",
    "installer disposed caller runtime",
  );
  installation = await installClear(runtime, { workerUrl: "/shell-worker.js" });
  check((await run("clear")).text === clear.text, "default asset URL does not work");
  await runtime.filesystem.writeFile("/bin/clear", encoder.encode("replacement"));
  await installation.dispose();
  check(
    decoder.decode(await runtime.filesystem.readFile("/bin/clear")) === "replacement",
    "disposal removed replacement",
  );
  await runtime.filesystem.writeFile("/bin/clear", encoder.encode("bash-web utility: clear\n"));
  installation = await installClear(runtime);
  await installation.dispose();
  check(
    (await runtime.filesystem.lookup("/bin/clear"))?.kind === "file",
    "disposal removed persisted marker",
  );
  await runtime.filesystem.remove("/bin/clear");
  check((await run("clear")).status === 127, "disposal retained executable registration");
  return {
    ok: true,
    loads,
    profiles: ["visible screen", "cursor home", "scrollback erased", "-x scrollback retained"],
    lifecycle: "lazy/conflict/reuse/default URL/owned and foreign marker disposal",
  };
}
void main()
  .then(
    (result) => Reflect.set(globalThis, "clearResult", result),
    (error: unknown) => Reflect.set(globalThis, "clearResult", { ok: false, error: String(error) }),
  )
  .finally(async () => {
    await shell?.dispose();
    await installation?.dispose();
    terminalRuntime?.dispose();
    await runtime.dispose();
    Reflect.set(globalThis, "clearCleaned", true);
  });
