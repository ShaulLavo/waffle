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
