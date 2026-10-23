import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

function command(
  command: string,
  args: string[],
  options: Parameters<typeof execFileSync>[2] = {},
): string {
  return execFileSync(command, args, { ...options, encoding: "utf8", stdio: "pipe" }).trim();
}

test("a clean app can install Waffle from a local Git commit and import every Node export", () => {
  const root = resolve(import.meta.dir, "..");
  const scratch = mkdtempSync(join(tmpdir(), "waffle-git-install-"));
  try {
    const bare = join(scratch, "waffle.git");
    command("git", ["clone", "--bare", root, bare]);
    const commit = command("git", ["-C", root, "rev-parse", "HEAD"]);
    const app = join(scratch, "app");
    const cache = join(scratch, "empty-cache");
    const global = join(scratch, "global");
    const config = join(scratch, "config");
    mkdirSync(app, { recursive: true });
    mkdirSync(cache, { recursive: true });
    mkdirSync(global, { recursive: true });
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(app, "package.json"),
      JSON.stringify(
        {
          name: "waffle-clean-consumer",
          private: true,
          type: "module",
          dependencies: { waffle: `git+file://${bare}#${commit}` },
          trustedDependencies: ["waffle"],
        },
        null,
        2,
      ) + "\n",
    );
    const env = {
      ...process.env,
      BUN_INSTALL_CACHE_DIR: cache,
      BUN_INSTALL_GLOBAL_DIR: global,
      BUN_CONFIG_DIR: config,
    };
    execFileSync("bun", ["install", "--no-progress"], { cwd: app, env, stdio: "pipe" });
    const metadata = JSON.parse(
      readFileSync(join(app, "node_modules/waffle/package.json"), "utf8"),
    ) as {
      name: string;
      exports: Record<string, { node?: string }>;
    };
    const specifiers = Object.entries(metadata.exports)
      .filter(([, target]) => target.node !== undefined)
      .map(([key]) => (key === "." ? metadata.name : `${metadata.name}${key.slice(1)}`));
    const script = `
      import assert from 'node:assert/strict';
      for (const specifier of ${JSON.stringify(specifiers)}) await import(specifier);
      const { createRuntime } = await import('waffle');
      assert.equal(typeof createRuntime, 'function');
      const api = await import('waffle/fs');
      const pair = api.createFilesystemConnection(undefined, { workspace: true });
      const service = new api.FilesystemService(new api.MemoryBackend());
      service.connect(pair.server);
      const client = new api.FilesystemClient(pair.client);
      const workspace = api.createWorkspaceVfs(client);
      try {
        await client.asyncCall('writeFile', ['/installed'], new Uint8Array([1]));
        const first = await workspace.read('/installed');
        assert.equal(first.kind, 'ok');
        assert.equal(first.value.bytes[0], 1);
        const pinned = await workspace.pin(first.value.stat.id);
        assert.equal(pinned.kind, 'ok');
        assert.equal((await workspace.stat('/installed', first.value.stat.cut)).kind, 'ok');
        const cursor = workspace.snapshot({ prefix: '/installed', includeDirs: false });
        let cut;
        let identity;
        for (;;) {
          const page = await cursor.next();
          if (page.kind === 'complete') { cut = page.cut; break; }
          assert.equal(page.kind, 'entries');
          for (const entry of page.entries) {
            assert.equal(entry.path, '/installed');
            assert.equal(typeof entry.id, 'bigint');
            assert.equal(typeof entry.version, 'bigint');
            identity = entry.id;
          }
        }
        await cursor.close();
        assert.equal(typeof cut.generation, 'bigint');
        assert.equal(typeof cut.watermark.seq, 'bigint');
        await client.asyncCall('writeFile', ['/installed'], new Uint8Array([2]));
        const page = await workspace.changes(cut.watermark);
        assert.equal(page.kind, 'changes');
        assert.equal(page.batches.length, 1);
        const old = await pinned.value.read({offset: 0, length: 1});
        assert.equal(old.kind, 'ok');
        assert.equal(old.value.bytes[0], 1);
        assert.equal((await workspace.read(identity)).value.bytes[0], 2);
        await pinned.value.close();
        assert.equal((await workspace.read(identity, {offset: 0, length: 1}, first.value.stat.version)).kind, 'version-gone');
        assert(page.batches[0].changes.some(change => change.kind === 'write' && change.id === identity && change.paths[0] === '/installed'));
      } finally {
        await workspace.close();
        client.dispose();
        service.dispose();
      }
    `;
    expect(() =>
      execFileSync("node", ["--input-type=module", "--eval", script], {
        cwd: app,
        env,
        stdio: "pipe",
      }),
    ).not.toThrow();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
