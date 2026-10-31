import { createRuntime } from "waffle";
import { createShell, type Shell } from "bash-web/shell";
import { installSed } from "bash-web/utilities/sed";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: "/fs-worker.js" } });
const results: Array<{ name: string; details: unknown }> = [];
let shell: Shell | undefined;
let output: number[] = [];
let drain: ReturnType<typeof setInterval> | undefined;
let loads = 0;

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function text() {
  if (shell) output = output.concat(Array.from(shell.terminal.drain())).slice(-1048576);
  return decoder.decode(Uint8Array.from(output));
}
async function until(predicate: () => boolean, label: string, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > deadline)
      throw new Error(`Timed out: ${label}; output=${text().slice(-1500)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function start(script?: string) {
  output = [];
  shell = await createShell({
    runtime,
    script,
    wasmUrl: "/shell-engine.wasm",
    workerUrl: "/shell-worker.js",
    env: { PATH: "/bin", LC_ALL: "C", PS1: "sed-prompt> " },
  });
  drain = setInterval(text, 5);
  return shell;
}
async function stop() {
  clearInterval(drain);
  if (!shell) return;
  const current = shell;
  await current.dispose();
  assert(current.diagnostics().roots.length === 0, "disposed shell retains runtime roots");
  shell = undefined;
}
async function run(script: string) {
  const current = await start(script);
  try {
    const exit = await Promise.race([
      current.done,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`script timed out: ${script}`)), 10000),
      ),
    ]);
    const bytes = output.concat(Array.from(current.terminal.drain()));
    return { exit, bytes, text: decoder.decode(Uint8Array.from(bytes)) };
  } finally {
    await stop();
  }
}
async function exact(name: string, script: string, expected: readonly number[]) {
  const result = await run(script);
  assert(result.exit.code === 0, `${name}: ${JSON.stringify(result)}`);
  assert(
    JSON.stringify(result.bytes) === JSON.stringify(expected),
    `${name}: ${JSON.stringify(result)}`,
  );
  results.push({ name, details: result });
}
async function rejections() {
  for (const script of [
    "w /sentinel\ne echo forbidden",
    "w /sentinel\ns/x/y/e",
    "s/x/y/w /sentinel\ne echo forbidden",
  ]) {
    await runtime.filesystem.writeFile("/sentinel", encoder.encode("keep"));
    const result = await run(`printf x | sed '${script}'`);
    assert(
      result.exit.code !== 0 && result.text.includes("not supported"),
      `rejection: ${JSON.stringify(result)}`,
    );
    assert(
      decoder.decode(await runtime.filesystem.readFile("/sentinel")) === "keep",
      "rejected script truncated output",
    );
    results.push({ name: "reject execution before output open", details: result });
  }
  for (const flag of ["-i", "-i.bak", "--in-place=.bak", "-ni"]) {
    await runtime.filesystem.writeFile("/sentinel", encoder.encode("keep"));
    const result = await run(`sed ${flag} 'w /sentinel' /sentinel`);
    assert(
      result.exit.code !== 0 && result.text.includes("in-place editing is not supported"),
      JSON.stringify(result),
    );
    assert(
      decoder.decode(await runtime.filesystem.readFile("/sentinel")) === "keep",
      "-i changed input",
    );
    assert(!(await runtime.filesystem.lookup("/sentinel.bak")), "-i created backup");
  }
  results.push({ name: "reject all in-place forms before writes", details: "4 forms" });
}
async function interactive() {
  const current = await start();
  const send = (command: string) =>
    assert(current.terminal.send(encoder.encode(command)), "terminal input full");
  try {
    await until(() => text().includes("sed-prompt> "), "initial prompt");
    output = [];
    send("sed -u 's/foo/ONE/'\n");
    await until(
      () => current.diagnostics().roots.some((root) => root.workers === 1),
      "streaming guest",
    );
    output = [];
    send("foo\n");
    await until(() => text().includes("ONE\n"), "output before EOF");
    assert(
      current.diagnostics().roots.some((root) => root.workers === 1),
      "producer reached EOF before output",
    );
    results.push({ name: "stream before EOF", details: current.diagnostics() });
    current.interrupt();
    await until(() => text().includes("sed-prompt> "), "read-wait interrupt recovery");
    output = [];
    send("printf '__status:%s__\\n' \"$?\"\n");
    await until(() => text().includes("__status:130__"), "read-wait status");
    results.push({ name: "Ctrl-C read wait and shell reuse", details: text() });

    for (const command of [
      "printf x | sed ':x;bx'",
      "while :; do printf 'x\\n'; done | sed -u ''",
    ]) {
      output = [];
      send(`${command}\n`);
      await until(
        () => current.diagnostics().roots.some((root) => root.workers === 1),
        "interrupt target",
      );
      clearInterval(drain);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const before = current.diagnostics();
      current.interrupt();
      drain = setInterval(text, 5);
      await until(() => text().includes("sed-prompt> "), "Ctrl-C prompt");
      output = [];
      send("printf '__status:%s__\\n' \"$?\"\n");
      await until(() => text().includes("__status:130__"), "Ctrl-C status and recovery");
      await until(
        () =>
          current
            .diagnostics()
            .roots.every(
              (root) => root.workers === 0 && root.pipes === 0 && root.liveProcesses === 1,
            ),
        "guest resources reclaimed",
      );
      results.push({
        name: `Ctrl-C ${command}`,
        details: { before, after: current.diagnostics() },
      });
    }
  } finally {
    await stop();
  }
}
async function main() {
  const installation = await installSed(runtime, {
    source: async () => {
      loads++;
      return new Uint8Array(await (await fetch("/sed.wasm")).arrayBuffer());
    },
    workerUrl: "/shell-worker.js",
  });
  try {
    assert(Number(loads) === 0, "sed loaded at install time");
    await exact(
      "unterminated output",
      "printf 'foo\\nbar' | sed 's/foo/ONE/'",
      Array.from(encoder.encode("ONE\nbar")),
    );
    assert(Number(loads) === 1, "first use did not load source once");
    await runtime.filesystem.writeFile("/bytes", Uint8Array.of(0, 255, 97, 10, 98));
    await exact("NUL and non-UTF8 bytes", "sed '' /bytes", [0, 255, 97, 10, 98]);
    await exact(
      "BRE capture and backreference",
      "printf 'abab\\n' | sed 's/\\(ab\\)\\1/\\1/'",
      Array.from(encoder.encode("ab\n")),
    );
    await exact("ERE", "printf 'aaab\\n' | sed -E 's/a+/X/'", Array.from(encoder.encode("Xb\n")));
    await exact(
      "range",
      "printf 'a\\nb\\nc\\n' | sed -n '2,3p'",
      Array.from(encoder.encode("b\nc\n")),
    );
    await rejections();
    await runtime.filesystem.writeFile("/sentinel", encoder.encode("keep"));
    await run("sed -n '99w /sentinel' /bytes");
    assert(
      (await runtime.filesystem.readFile("/sentinel"))?.length === 0,
      "valid nonmatching w did not create empty output",
    );
    results.push({
      name: "valid output files open after compilation",
      details: "nonmatching w truncates as upstream",
    });
    await exact(
      "early quit stops unbounded producer",
      "while :; do printf 'a\\n'; done | sed '1q'",
      [97, 10],
    );
    const broken = await run(
      "while :; do printf 'a\\n'; done | sed -u '' | sed '1q'; printf recovered",
    );
    assert(
      broken.exit.code === 0 && broken.text.endsWith("recovered"),
      `broken pipe: ${JSON.stringify(broken)}`,
    );
    results.push({ name: "broken pipe and subsequent command", details: broken });
    await interactive();
    assert(Number(loads) === 1, "source reloaded between processes");
    results.push({ name: "lazy source cached on caller runtime", details: { loads } });
  } finally {
    await installation.dispose();
  }
}
try {
  await main();
  Object.assign(globalThis, { sedResult: { ok: true, results } });
} catch (error) {
  Object.assign(globalThis, {
    sedResult: {
      ok: false,
      results,
      error: String(error),
      output: text(),
      diagnostics: shell?.diagnostics(),
    },
  });
} finally {
  await stop();
  await runtime.dispose();
  Object.assign(globalThis, { sedCleaned: true });
}
