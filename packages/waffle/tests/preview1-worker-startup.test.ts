import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const marker = "preview1 bootstrap failure";
type Stage = "missing" | "evaluation" | "bootstrap";

const host = `
  import { Worker } from "node:worker_threads";
  import { pathToFileURL } from "node:url";
  const worker = new Worker(pathToFileURL(process.argv[1]), { execArgv: [] });
  try {
    const failure = await new Promise((resolve, reject) => {
      worker.once("error", error => resolve({ kind: "error", message: error.message }));
      worker.once("message", resolve);
      worker.once("exit", code => reject(new Error("Worker exited without reporting: " + code)));
      worker.postMessage({});
    });
    process.stdout.write(JSON.stringify(failure));
  } finally {
    await worker.terminate();
  }
`;

async function observeFailure(stage: Stage): Promise<unknown> {
  const directory = await mkdtemp(join(tmpdir(), "waffle-preview1-startup-"));
  try {
    const source = await Bun.file(new URL("../browser/preview1-worker.ts", import.meta.url)).text();
    const entry = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
    // Node otherwise escalates unhandled rejections into host errors, unlike browser Workers.
    const dispatch = `
      import { parentPort } from "node:worker_threads";
      process.on("unhandledRejection", error => {
        parentPort.postMessage({ kind: "rejection", message: error.message });
      });
      parentPort.on("message", data => { globalThis.onmessage({ data }); });
    `;
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    await writeFile(join(directory, "entry.js"), dispatch + entry);
    if (stage !== "missing") await writeBootstrap(directory, stage);
    const result = await execute(
      "node",
      ["--input-type=module", "--eval", host, join(directory, "entry.js")],
      { timeout: 4_000 },
    );
    return JSON.parse(result.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeBootstrap(directory: string, stage: Exclude<Stage, "missing">) {
  const bootstrap = `export async function bootstrap() { throw new Error(${JSON.stringify(marker)}); }
    export const preview1Executor = {};`;
  const source = stage === "evaluation" ? `throw new Error(${JSON.stringify(marker)});` : bootstrap;
  await writeFile(join(directory, "worker.js"), source);
}

test.each(["missing", "evaluation"] satisfies Stage[])(
  "Preview 1 bootstrap %s failure reaches the host Worker error path",
  async (stage) => {
    const failure = await observeFailure(stage);
    expect(failure).toMatchObject({ kind: "error" });
    if (stage === "evaluation") expect(failure).toEqual({ kind: "error", message: marker });
  },
);

test("Preview 1 preserves bootstrap promise rejection semantics", async () => {
  expect(await observeFailure("bootstrap")).toEqual({ kind: "rejection", message: marker });
});
