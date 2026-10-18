import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { BrowserRunnerLifecycle } from "./browser-runner-lifecycle.ts";
import type { BrowserResourceOwner } from "./process-recycling-browser-runner-control.ts";

for (const phase of ["creation", "closure"] as const) test(`persistent ${phase} timeout cannot erase independent ownership`, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "vfs-owner-"));
  const profile = resolve(root, "profile"); await mkdir(profile);
  const lifecycle = new BrowserRunnerLifecycle(60000, 5);
  // Deliberately fault-inject the ownership ledger, with no actual browser or
  // enclosing Browser. An initially empty browser set is not shutdown evidence.
  const ledger = lifecycle as unknown as { contexts: Set<BrowserResourceOwner>; directories: Set<Promise<string>> };
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const resource = { close: () => phase === "closure" ? gate : Promise.resolve(), browser: () => null };
  const creation = phase === "creation" ? gate.then(() => resource) : Promise.resolve(resource);
  const owner: BrowserResourceOwner = { creation, stopped: false };
  ledger.contexts.add(owner); ledger.directories.add(Promise.resolve(profile));
  try {
    await expect(lifecycle.close()).rejects.toThrow("cleanup failed");
    expect(ledger.contexts.has(owner)).toBe(true);
    expect((await stat(profile)).isDirectory()).toBe(true);
  } finally {
    finish(); await creation; await gate;
    // Late closure is still attached to the original owner, not abandoned.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(owner.stopped).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary browser closure failure is not a controller interruption", async () => {
  const lifecycle = new BrowserRunnerLifecycle(60000, 5);
  const context = { close: () => Promise.reject(new Error("Target page, context or browser has been closed")), browser: () => null };
  const owner = { creation: Promise.resolve(context), stopped: false };
  (lifecycle as unknown as { contexts: Set<BrowserResourceOwner> }).contexts.add(owner);
  await expect(lifecycle.closeContext(context as unknown as Parameters<typeof lifecycle.closeContext>[0])).rejects.toThrow("has been closed");
  expect(lifecycle.controllerInterrupted).toBe(false);
  await expect(lifecycle.close()).rejects.toThrow("cleanup failed");
});

test("controller deadline marks interruption before closing owned resources", () => {
  const script = `import { BrowserRunnerLifecycle } from ${JSON.stringify(resolve(import.meta.dir, "browser-runner-lifecycle.ts"))};
    const lifecycle = new BrowserRunnerLifecycle(5);
    (lifecycle as unknown as { contexts: Set<unknown> }).contexts.add({ creation: Promise.resolve({ close: async () => console.log("controller-interrupted=" + lifecycle.controllerInterrupted) }), stopped: false });`;
  const result = Bun.spawnSync([process.execPath, "--eval", script], { timeout: 5000 });
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toContain("controller-interrupted=true");
  expect(result.stderr.toString()).toContain("Browser runner timed out");
});
