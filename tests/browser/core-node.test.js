import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

test('plain Node can consume the JS memory helper through the existing host adapters', () => {
  const source = `await import(${JSON.stringify(new URL('../src/subprocess.js', import.meta.url).href)});`;
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

test('unbundled headless hosts load in a dependency-free source checkout', async () => {
  const { copyFile, mkdir, mkdtemp, rm } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const base = process.env.RUNNER_TEMP ?? process.env.SCRATCH ?? (existsSync('/work/tmp') ? '/work/tmp' : tmpdir());
  const dir = await mkdtemp(join(base, 'bun-wasm-node-clean-'));
  try {
    for (const path of ['web/package.json', 'runtime/package.json', 'runtime/core/memory-views.js',
      'web/src/crypto-inputs.js', 'web/src/crypto-host.js',
      'web/scripts/node-host.mjs', 'web/scripts/node-stdio.ts', 'web/scripts/node-install-net.mjs', 'web/src/subprocess.js', 'web/src/engine-host.js', 'web/src/native-stream-state.ts']) {
      const target = join(dir, path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(new URL(`../../${path}`, import.meta.url), target);
    }
    const imports = ['web/src/engine-host.js', 'web/src/subprocess.js', 'web/scripts/node-install-net.mjs', 'web/scripts/node-stdio.ts'];
    const load = spawnSync('node', ['--input-type=module', '-e', `for (const path of ${JSON.stringify(imports)}) await import('./' + path);`], { cwd: dir, encoding: 'utf8' });
    expect(load.stderr).toBe('');
    expect(load.status).toBe(0);
    // Stop deliberately at the missing guest: reaching this read proves imports linked without npm.
    const missing = join(dir, 'missing-guest.wasm');
    const launch = spawnSync('node', [join(dir, 'web/scripts/node-host.mjs'), '--wasm', missing, '--', '--version'], { cwd: dir, encoding: 'utf8' });
    expect(launch.status).toBe(1);
    expect(launch.stderr).toContain('ENOENT');
    expect(launch.stderr).toContain(missing);
    expect(launch.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
