import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { identity as dateIdentity } from "./build-native-date-oracle.ts";
import {
  checksumOracleIdentity,
  identityKey,
  verifyNativeChecksums,
} from "./build-native-checksum-oracle.ts";
import { readFixture, selectChecksumOracle, verifyFixture } from "./checksum-oracle.ts";
import { checksumNames } from "./programs.ts";

const builder = resolve(import.meta.dirname, "build-native-checksum-oracle.ts");
const parent = resolve(import.meta.dirname, "../../../.build");
mkdirSync(parent, { recursive: true });
const scratch = mkdtempSync(resolve(parent, "checksum-native-oracle-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
let caches = 0;

/** Receipted stand-ins: they print the pinned versions but compute no checksums. */
function fakeCache(version = "9.12") {
  const root = resolve(scratch, `cache-${caches++}`);
  mkdirSync(root);
  const binaries: Record<string, { version: string; sha256: string }> = {};
  for (const name of checksumNames) {
    const script = `#!/bin/sh\necho '${name} (GNU coreutils) ${version}'\n`;
    writeFileSync(resolve(root, name), script);
    chmodSync(resolve(root, name), 0o755);
    binaries[name] = { version: `${name} (GNU coreutils) 9.12`, sha256: sha(script) };
  }
  writeMetadata(root, {
    schema: 1,
    identity: checksumOracleIdentity(),
    makeTargets: checksumNames.map((name) => `src/${name}`),
    builtExecutables: checksumNames,
    configHeaderSha256: "0".repeat(64),
    binaries,
  });
  return root;
}

function readMetadata(root: string) {
  return JSON.parse(readFileSync(resolve(root, "metadata.json"), "utf8"));
}

function writeMetadata(root: string, metadata: unknown) {
  writeFileSync(resolve(root, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
}

function cli(args: readonly string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [builder].concat(args), {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("identity reuses the pinned GNU 9.12 recipe and selects only the nine checksum targets", () => {
  const identity = checksumOracleIdentity();
  assert.equal(identity.recipe, "gnu-checksum-native-oracle-v1");
  assert.equal(identity.recipeSha256, sha(readFileSync(builder)));
  assert.deepEqual(identity.base, dateIdentity());
  assert.equal(
    identity.base.source.archiveSha256,
    "a480198559733e9b3da999e90543ac6f888a2caa544d8d664c5a1f17e528e210",
  );
  assert.equal(
    identity.sourceLockSha256,
    sha(readFileSync(resolve(import.meta.dirname, "gnu-date-source.json"))),
  );
  assert.deepEqual(
    identity.makeTargets,
    checksumNames.map((name) => `src/${name}`),
  );
  assert.deepEqual(
    identity.versions,
    Object.fromEntries(checksumNames.map((name) => [name, `${name} (GNU coreutils) 9.12`])),
  );
  const printed = cli(["--identity"], {});
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout.trim(), identityKey(identity));
});

test("a receipted cache is selected, but only reproduced observations qualify it", () => {
  const root = fakeCache();
  const verified = verifyNativeChecksums(root);
  assert.equal(verified.utilities.sha256sum.path, resolve(root, "sha256sum"));
  const oracle = selectChecksumOracle({ GNU_CHECKSUM_ORACLE_ROOT: root });
  assert.equal(oracle.kind, "source-cache");
  assert.deepEqual(oracle.utilities, verified.utilities);
  assert.throws(() => verifyFixture(readFixture(), oracle), /reads stdin/);
});

const refusals: ReadonlyArray<readonly [string, (root: string) => void, RegExp]> = [
  ["altered binary", (root) => writeFileSync(resolve(root, "md5sum"), "#!/bin/sh\n"), /md5sum/],
  [
    "altered source recipe",
    (root) => {
      const metadata = readMetadata(root);
      metadata.identity.base.source.archiveSha256 = "f".repeat(64);
      writeMetadata(root, metadata);
    },
    /identity changed/,
  ],
  [
    "altered recorded compiler",
    (root) => {
      const metadata = readMetadata(root);
      metadata.identity.base.compiler.sha256 = "f".repeat(64);
      writeMetadata(root, metadata);
    },
    /identity changed/,
  ],
  [
    "date make target",
    (root) => {
      const metadata = readMetadata(root);
      metadata.makeTargets.push("src/date");
      writeMetadata(root, metadata);
    },
    /make targets changed/,
  ],
  [
    "unrelated cached program",
    (root) => writeFileSync(resolve(root, "date"), "#!/bin/sh\n"),
    /unexpected files/,
  ],
  ["missing program", (root) => unlinkSync(resolve(root, "sum")), /unexpected files/],
  [
    "symlinked program",
    (root) => {
      unlinkSync(resolve(root, "b2sum"));
      symlinkSync("/usr/bin/b2sum", resolve(root, "b2sum"));
    },
    /b2sum is not a cached executable/,
  ],
];

for (const [name, alter, error] of refusals) {
  test(`cache refuses ${name}`, () => {
    const root = fakeCache();
    alter(root);
    assert.throws(() => verifyNativeChecksums(root), error);
    assert.throws(() => selectChecksumOracle({ GNU_CHECKSUM_ORACLE_ROOT: root }), error);
  });
}

test("cache refuses a binary whose version differs from its receipt", () => {
  const root = fakeCache("9.11");
  assert.throws(() => verifyNativeChecksums(root), /version changed/);
});

test("cache refuses a different current compiler", () => {
  const root = fakeCache();
  const wrapper = resolve(scratch, "cc-wrapper");
  writeFileSync(wrapper, '#!/bin/sh\nexec cc "$@"\n');
  chmodSync(wrapper, 0o755);
  const original = process.env.CC;
  process.env.CC = wrapper;
  try {
    assert.throws(() => verifyNativeChecksums(root), /identity changed/);
  } finally {
    if (original === undefined) delete process.env.CC;
    else process.env.CC = original;
  }
});

test("oracle selection is explicit and never mixes providers", () => {
  const root = fakeCache();
  assert.throws(() => selectChecksumOracle({}), /GNU_CHECKSUM_ORACLE=recording-host/);
  assert.throws(() => selectChecksumOracle({ GNU_CHECKSUM_ORACLE: "usr-bin" }), /recording-host/);
  assert.throws(() => selectChecksumOracle({ GNU_CHECKSUM_ORACLE_ROOT: "" }), /exactly one/);
  assert.throws(
    () =>
      selectChecksumOracle({
        GNU_CHECKSUM_ORACLE_ROOT: root,
        GNU_CHECKSUM_ORACLE: "recording-host",
      }),
    /exactly one/,
  );
  const fixture = readFixture();
  const sum = fixture.utilities.sum;
  assert.ok(sum);
  const altered = {
    ...fixture,
    utilities: { ...fixture.utilities, sum: { ...sum, sha256: "0".repeat(64) } },
  };
  assert.throws(() => selectChecksumOracle({ GNU_CHECKSUM_ORACLE: "recording-host" }, altered));
});

test("the provisioner fails closed instead of rebuilding a present or absent cache", () => {
  const absent = cli(["--verify-only"], {
    GNU_CHECKSUM_ORACLE_ROOT: resolve(scratch, "absent"),
  });
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /cache is absent/);
  const root = fakeCache();
  writeFileSync(resolve(root, "sha1sum"), "#!/bin/sh\n");
  const before = readFileSync(resolve(root, "metadata.json"));
  const invalid = cli([], { GNU_CHECKSUM_ORACLE_ROOT: root });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /sha1sum cache binary checksum changed/);
  assert.deepEqual(readFileSync(resolve(root, "metadata.json")), before);
  assert.equal(readFileSync(resolve(root, "sha1sum"), "utf8"), "#!/bin/sh\n");
});
