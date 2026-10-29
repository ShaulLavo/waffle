// Waffle-free WebKit navigation loop. While a navigation is stalled, keep its Playwright
// protocol window, the browser process tree and thread stacks. Diagnostic branch only.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const [outArg, variant, secondsArg] = process.argv.slice(2);
if (!outArg || (variant !== "coop" && variant !== "plain") || !secondsArg)
  throw new Error("usage: probe.ts <out-dir> coop|plain <seconds>");
const out = resolve(outArg);
mkdirSync(out, { recursive: true });

type Line = { seq: number; text: string };
const ring: Line[] = [];
let seq = 0;
const write = process.stderr.write.bind(process.stderr);
process.env.DEBUG = "pw:protocol";
process.env.DEBUG_COLORS = "0";
process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
  const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
  if (!text.includes("pw:protocol")) return write(chunk, ...rest);
  ring.push({ seq: seq++, text: text.length > 1500 ? text.slice(0, 1500) + " [cut]\n" : text });
  if (ring.length > 6000) ring.splice(0, 2000);
  return true;
}) as typeof process.stderr.write;
const { webkit } = await import("playwright");

const headers: Record<string, string> = { "content-type": "text/html" };
if (variant === "coop") {
  headers["Cross-Origin-Opener-Policy"] = "same-origin";
  headers["Cross-Origin-Embedder-Policy"] = "require-corp";
}
let served = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    served++;
    return new Response("<!doctype html><title>probe</title>", { headers });
  },
});

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    return `unavailable: ${(error as Error).message}`;
  }
}
function descendants(root: number): number[] {
  const children = new Map<number, number[]>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const stat = read(`/proc/${name}/stat`);
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    children.set(ppid, (children.get(ppid) ?? []).concat(Number(name)));
  }
  const result: number[] = [];
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift()!;
    const next = children.get(pid) ?? [];
    result.push(...next);
    queue.push(...next);
  }
  return result;
}
function threads(pid: number) {
  let tids: string[] = [];
  try {
    tids = readdirSync(`/proc/${pid}/task`);
  } catch {}
  return tids.map((tid) => ({
    tid,
    comm: read(`/proc/${pid}/task/${tid}/comm`).trim(),
    stat: read(`/proc/${pid}/task/${tid}/stat`).trim(),
    wchan: read(`/proc/${pid}/task/${tid}/wchan`).trim(),
    syscall: read(`/proc/${pid}/task/${tid}/syscall`).trim(),
  }));
}
function stacks(pid: number): string {
  const result = spawnSync(
    "sudo",
    ["-n", "timeout", "45", "gdb", "-batch", "-nx", "-p", String(pid)].concat([
      "-ex",
      "set pagination off",
      "-ex",
      "thread apply all bt 30",
    ]),
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.slice(-200_000);
}

function capture(index: number, startSeq: number, elapsed: number, servedAtStart: number) {
  const directory = resolve(out, `stall-${index}`);
  mkdirSync(directory, { recursive: true });
  const window = ring.filter((line) => line.seq >= startSeq - 40).map((line) => line.text);
  writeFileSync(resolve(directory, "protocol.log"), window.join(""));
  const pids = descendants(process.pid);
  const processes = pids.map((pid) => ({
    pid,
    cmdline: read(`/proc/${pid}/cmdline`).replaceAll("\0", " ").slice(0, 400),
    status: read(`/proc/${pid}/status`).slice(0, 1200),
    threads: threads(pid),
  }));
  writeFileSync(
    resolve(directory, "processes.json"),
    JSON.stringify({ elapsed, servedAtStart, servedNow: served, processes }, null, 1),
  );
  const browserPids = processes
    .filter((entry) => /WebKit|MiniBrowser|WPE|GTK/i.test(entry.cmdline))
    .map((entry) => entry.pid)
    .slice(0, 12);
  for (const pid of browserPids) writeFileSync(resolve(directory, `gdb-${pid}.txt`), stacks(pid));
}

const deadline = Date.now() + Number(secondsArg) * 1000;
const browser = await webkit.launch();
const version = browser.version();
const durations: number[] = [];
const stalls: { index: number; outcome: string; gotoMs: number; served: number }[] = [];
let navigations = 0;
try {
  while (Date.now() < deadline && stalls.length < 2) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const startSeq = seq;
    const servedAtStart = served;
    const started = performance.now();
    let settled = false;
    const navigation = page
      .goto(`http://127.0.0.1:${server.port}/`, { timeout: 60_000 })
      .then(
        () => "loaded",
        (error: Error) => `rejected ${error.name}: ${error.message.split("\n")[0]}`,
      )
      .finally(() => (settled = true));
    const index = navigations;
    const timer = setTimeout(() => {
      if (!settled) capture(index, startSeq, performance.now() - started, servedAtStart);
    }, 8_000);
    const outcome = await navigation;
    clearTimeout(timer);
    const gotoMs = performance.now() - started;
    durations.push(gotoMs);
    if (gotoMs > 8_000) {
      stalls.push({ index, outcome, gotoMs, served: served - servedAtStart });
      writeFileSync(
        resolve(out, `stall-${index}`, "after.log"),
        ring
          .filter((line) => line.seq >= startSeq)
          .map((line) => line.text)
          .join("")
          .slice(-400_000),
      );
    }
    if (outcome === "loaded") await page.evaluate(() => document.title);
    await context.close();
    navigations++;
  }
} finally {
  await browser.close();
  server.stop(true);
  durations.sort((a, b) => a - b);
  const at = (q: number) => Math.round(durations[Math.floor((durations.length - 1) * q)] ?? 0);
  const result = {
    variant,
    version,
    navigations,
    served,
    stalls,
    gotoMs: { p50: at(0.5), p99: at(0.99), max: at(1) },
    slow: durations.filter((ms) => ms > 2_000).map(Math.round),
  };
  writeFileSync(resolve(out, "result.json"), JSON.stringify(result, null, 1));
  console.log(JSON.stringify(result));
}
