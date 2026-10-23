import { expect, test } from "bun:test";
import { MemFS } from "../fs/memory";
import {
  createFilesystemConnection,
  createWorkspaceVfs,
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
} from "../fs/index";

type Mode = "close" | "abort" | "complete";
const modes: readonly Mode[] = ["close", "abort", "complete"];
const CHILD = "WAFFLE_ROOT_RELEASE_CHILD";

async function retire(mode: Mode) {
  const fs = new MemFS();
  for (let n = 0; n < 260; n++) fs.writeFile(`/a/f${n}`, new Uint8Array());
  const root = new WeakRef(fs.root);
  const backend = new MemoryBackend(fs);
  const pair = createFilesystemConnection(undefined, { workspace: true });
  const service = new FilesystemService(backend);
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  const workspace = createWorkspaceVfs(client);
  const abort = new AbortController();
  const cursor = workspace.snapshot(undefined, abort.signal);
  try {
    if ((await cursor.next()).kind !== "entries") throw new Error("first page was not entries");
    if (mode === "abort") abort.abort();
    let page = mode === "complete" ? await cursor.next() : undefined;
    while (page?.kind === "entries") page = await cursor.next();
    await cursor.close();
    const terminal = await cursor.next();
    const resources = service.resources();
    if (resources.workspaceCursors || resources.responses || client.completions.size)
      throw new Error("terminal cursor kept service resources");
    await client.asyncCall("writeFile", ["/still-owned"], new Uint8Array([1]));
    return { root, cursor, terminal };
  } finally {
    await cursor.close();
    await workspace.close();
    client.dispose();
    service.dispose();
  }
}

async function collected(root: WeakRef<object>): Promise<boolean> {
  for (let round = 0; round < 20; round++) {
    await Bun.sleep(5);
    Bun.gc(true);
    if (!root.deref()) return true;
  }
  return false;
}

async function child(): Promise<void> {
  for (const mode of modes) {
    const { root, cursor, terminal } = await retire(mode);
    const rootCollected = await collected(root);
    const repeated = await cursor.next();
    console.log(
      JSON.stringify({ mode, rootCollected, terminal: terminal.kind, repeated: repeated.kind }),
    );
  }
  // A leaked port would also keep the event loop alive; report the retention instead of hanging.
  process.exit();
}

if (process.env[CHILD]) await child();
else
  test("disposed workspace root collects while its terminal cursor stays reachable", async () => {
    // JSC's concurrent JIT worklist holds compiled closures and their scopes for an unbounded
    // time; it retained the root through backend locals on slow hosts. Synchronous JIT keeps
    // the probe about Waffle ownership.
    const run = Bun.spawn([process.execPath, import.meta.path], {
      env: { ...process.env, [CHILD]: "1", BUN_JSC_useConcurrentJIT: "0" },
      stdout: "pipe",
      stderr: "pipe",
      // Bun kills a hung child well before the test deadline, which closes both pipes.
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(run.stdout).text(),
        new Response(run.stderr).text(),
        run.exited,
      ]);
      expect({ code, signal: run.signalCode, stderr }).toEqual({
        code: 0,
        signal: null,
        stderr: "",
      });
      expect(
        stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual(
        modes.map((mode) => ({
          mode,
          rootCollected: true,
          terminal: mode === "complete" ? "complete" : "cancelled",
          repeated: mode === "complete" ? "complete" : "cancelled",
        })),
      );
    } finally {
      run.kill("SIGKILL");
      await run.exited;
    }
  }, 60_000);
