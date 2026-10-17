import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

test('plain Node can consume the JS memory helper through the existing host adapters', () => {
  const source = `await import(${JSON.stringify(new URL('../src/subprocess.ts', import.meta.url).href)});`;
  const result = spawnSync('node', ['--input-type=module', '-e', source], { encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});

test('module-preparation benchmark links its actual Node host before creating fixtures', () => {
  const result = spawnSync('node', [new URL('../../scripts/bench-module-preparation.mjs', import.meta.url).pathname, '--check'], { encoding: 'utf8' });
  expect(result.status).toBe(0);
});

test('browser memory gate source assets still exist after runtime extraction', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const script = new URL('./browser-memory.mjs', import.meta.url);
  const source = readFileSync(script, 'utf8');
  const assets = Array.from(source.matchAll(/readFileSync\(new URL\("([^"]+)", import\.meta\.url\)/g), match => match[1]);
  expect(assets.length).toBeGreaterThan(0);
  for (const path of assets) expect(existsSync(new URL(path, script))).toBe(true);
});

test('unbundled headless hosts load with their installed runtime package', async () => {
  const { copyFile, cp, mkdir, mkdtemp, rm } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { fileURLToPath } = await import('node:url');
  const { resolveRuntimePackage } = await import('../../scripts/browser-build');
  const base = process.env.RUNNER_TEMP ?? process.env.SCRATCH ?? process.env.TMPDIR ?? (existsSync('/work/tmp') ? '/work/tmp' : tmpdir());
  const dir = await mkdtemp(join(base, 'bun-wasm-node-clean-'));
  try {
    for (const path of ['web/package.json',
      'web/src/crypto-inputs.js', 'web/src/crypto-host.js', 'web/src/content-modules.ts',
      'web/scripts/node-host.mjs', 'web/scripts/node-signals.ts', 'web/scripts/node-stdio.ts', 'web/scripts/node-spawn.ts', 'web/scripts/node-process.ts', 'web/scripts/node-install-net.mjs', 'web/src/subprocess.ts', 'web/src/net/trampoline.ts', 'web/src/worker-pipes.ts', 'web/src/buffer-transfer.ts', 'web/src/engine-host.js', 'web/src/native-stream-state.ts']) {
      const target = join(dir, path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(new URL(`../../${path}`, import.meta.url), target);
    }
    // Copy the installed package, including its generated Node modules, not a
    // sibling runtime checkout. Host modules must link through package exports.
    const installed = resolveRuntimePackage(fileURLToPath(new URL('../src/main.ts', import.meta.url))).path;
    await cp(installed, join(dir, 'web/node_modules/@bun-wasm/runtime'), {
      recursive: true, dereference: true,
      filter(source) { return source === installed || !source.slice(installed.length + 1).split('/').includes('node_modules'); },
    });
    expect(existsSync(join(dir, 'runtime'))).toBe(false);
    expect(existsSync(join(dir, 'web/node_modules/@bun-wasm/runtime/dist/core/memory-views.js'))).toBe(true);
    const imports = ['web/src/engine-host.js', 'web/src/subprocess.ts', 'web/scripts/node-install-net.mjs', 'web/scripts/node-stdio.ts', 'web/scripts/node-process.ts'];
    const load = spawnSync('node', ['--input-type=module', '-e', `for (const path of ${JSON.stringify(imports)}) await import('./' + path);`], { cwd: dir, encoding: 'utf8' });
    expect(load.stderr).toBe('');
    expect(load.status).toBe(0);
    // Stop deliberately at the missing guest: reaching this read proves the installed package and host imports linked.
    const missing = join(dir, 'missing-guest.wasm');
    const launch = spawnSync('node', [join(dir, 'web/scripts/node-host.mjs'), '--wasm', missing, '--', '--version'], { cwd: dir, encoding: 'utf8' });
    expect(launch.status).toBe(1);
    expect(launch.stderr).toContain('ENOENT');
    expect(launch.stderr).toContain(missing);
    expect(launch.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
