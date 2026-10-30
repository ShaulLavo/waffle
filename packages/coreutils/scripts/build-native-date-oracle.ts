import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pin = {
  version: '9.12',
  archive: 'https://ftp.gnu.org/gnu/coreutils/coreutils-9.12.tar.xz',
  archiveSha256: 'a480198559733e9b3da999e90543ac6f888a2caa544d8d664c5a1f17e528e210',
  announcement: 'https://lists.gnu.org/archive/html/coreutils-announce/2026-09/msg00000.html',
  upstreamRevision: 'c0f8514d989184921d9b12a4d103a7b23abc5af8',
  tag: 'v9.12', announcementDate: '2026-09-14',
  observedPcBinarySha256: '7531de6570c4d067b6c73472407c89bc3e4e96c37bae20f55feab13d99d6771e',
};
const sourceInput: unknown = JSON.parse(readFileSync(resolve(here, 'gnu-date-source.json'), 'utf8'));
assert.deepEqual(sourceInput, pin, 'GNU source lock changed');
const recipe = 'gnu-date-native-oracle-v1';
const flags = ['--disable-nls', '--disable-rpath', '--without-selinux', '--without-libgmp', '--without-openssl', '--without-systemd', '--disable-acl', '--disable-xattr', '--disable-libcap', '--disable-libsmack'];
const root = resolve(process.env.GNU_DATE_ORACLE_ROOT ?? '.build/gnu-date-native-oracle');
const binary = resolve(root, 'date');
const metadata = resolve(root, 'metadata.json');
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const fileHash = (path: string) => sha(readFileSync(path));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: 'C', LANG: 'C', TZ: 'UTC0', CONFIG_SITE: '/dev/null', CFLAGS: '-O2', CPPFLAGS: '', LDFLAGS: '', MAKEFLAGS: '' };

function run(command: string, args: readonly string[], cwd = here, inherit = false): string {
  const result = spawnSync('timeout', ['--kill-after=5s', '240s', command].concat(args), {
    cwd, env, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe', maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `${command}: signal`);
  assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  return result.stdout ?? '';
}

function tool(name: string) {
  const path = realpathSync(run('sh', ['-c', 'command -v "$1"', 'sh', name]).trim());
  return { path, sha256: fileHash(path), version: run(path, ['--version']).split('\n')[0] };
}

export function identity() {
  const compiler = tool(process.env.CC ?? 'cc');
  const linker = tool('ld');
  const libc = run('getconf', ['GNU_LIBC_VERSION']).trim();
  const loader = run(compiler.path, ['-print-file-name=libc.so.6']).trim();
  assert.ok(loader.startsWith('/'), 'Compiler must resolve the native libc');
  return {
    recipe, recipeSha256: fileHash(fileURLToPath(import.meta.url)), source: pin,
    compiler: { ...compiler, target: run(compiler.path, ['-dumpmachine']).trim() },
    linker, libc: { version: libc, sha256: fileHash(realpathSync(loader)) },
    flags, cflags: env.CFLAGS, make: tool('make'), ar: tool('ar'),
  };
}

export function verifyNativeDate() {
  const expected = identity();
  const saved: unknown = JSON.parse(readFileSync(metadata, 'utf8'));
  assert.ok(saved && typeof saved === 'object' && 'schema' in saved && saved.schema === 1 && 'identity' in saved && 'binary' in saved);
  assert.deepEqual(saved.identity, expected, 'Native GNU date source/compiler/recipe identity changed');
  const record = saved.binary;
  assert.ok(record && typeof record === 'object' && 'sha256' in record && 'version' in record);
  assert.equal(record.sha256, fileHash(binary), 'Native GNU date cache binary checksum changed');
  assert.equal(record.version, 'date (GNU coreutils) 9.12');
  assert.equal(run(binary, ['--version']).split('\n')[0], record.version);
  return { path: binary, version: record.version, sha256: record.sha256 };
}

async function provision() {
  const expected = identity();
  const key = sha(JSON.stringify(expected));
  if (process.argv.includes('--identity')) { console.log(key); return; }
  const hasCache = existsSync(root) && readdirSync(root).length > 0;
  if (hasCache) {
    console.log(JSON.stringify({ kind: 'cache-hit', identity: key, oracle: verifyNativeDate() }));
    return;
  }
  assert.ok(!process.argv.includes('--verify-only'), 'GNU date cache is absent');
  const scratchRoot = process.env.GNU_DATE_ORACLE_SCRATCH_ROOT;
  assert.ok(scratchRoot, 'Set GNU_DATE_ORACLE_SCRATCH_ROOT to a verified data-drive directory');
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(resolve(scratchRoot, 'gnu-date-build-'));
  const stage = resolve(scratch, 'cache');
  mkdirSync(stage);
  try {
    const archive = resolve(scratch, 'coreutils.tar.xz');
    if (process.env.GNU_DATE_ARCHIVE) copyFileSync(process.env.GNU_DATE_ARCHIVE, archive);
    else run('curl', ['--fail', '--location', '--max-time', '60', pin.archive, '-o', archive]);
    assert.ok(statSync(archive).size <= 16 * 1024 * 1024, 'GNU source archive exceeds size limit');
    assert.equal(fileHash(archive), pin.archiveSha256, 'GNU date source archive checksum changed');
    run('tar', ['-xJf', archive, '-C', scratch]);
    const source = resolve(scratch, 'coreutils-9.12');
    const build = resolve(scratch, 'build');
    mkdirSync(build);
    run(resolve(source, 'configure'), flags.concat([`CC=${expected.compiler.path}`]), build, true);
    const generated = resolve(build, 'date-oracle.mk');
    writeFileSync(generated, 'date-oracle-generated: $(filter lib/% src/version.c src/version.h src/coreutils.h,$(BUILT_SOURCES))\n');
    run('make', ['-j2', '-f', 'Makefile', '-f', generated, 'date-oracle-generated'], build, true);
    run('make', ['-j2', 'V=1', 'src/date'], build, true);
    copyFileSync(resolve(build, 'src/date'), resolve(stage, 'date'));
    chmodSync(resolve(stage, 'date'), 0o755);
    const nativeVersionOutput = run(resolve(stage, 'date'), ['--version']);
    assert.equal(nativeVersionOutput.split('\n')[0], 'date (GNU coreutils) 9.12');
    const builtExecutables = readdirSync(resolve(build, 'src'), { withFileTypes: true })
      .filter(entry => entry.isFile() && !entry.name.includes('.') && entry.name !== 'date')
      .map(entry => entry.name);
    assert.deepEqual(builtExecutables, [], 'Another coreutils program was built');
    writeFileSync(resolve(stage, 'metadata.json'), JSON.stringify({ schema: 1, identity: expected, binary: { version: 'date (GNU coreutils) 9.12', sha256: fileHash(resolve(stage, 'date')) }, builtExecutables: ['date'], nativeVersionOutput }, null, 2) + '\n');
    mkdirSync(dirname(root), { recursive: true });
    rmSync(root, { recursive: true, force: true });
    renameSync(stage, root);
    console.log(JSON.stringify({ kind: 'built', identity: key, oracle: verifyNativeDate() }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await provision();
