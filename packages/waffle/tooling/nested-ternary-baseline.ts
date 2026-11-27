import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type NestedTernaryBaseline = Readonly<Record<string, readonly string[]>>;

/** Pre-existing legacy nested-ternary expression fingerprints per file (12-char SHA-256 of
 * whitespace-normalized expression source). Baseline only shrinks: adding or replacing a nested
 * ternary in a listed file fails lint, and removing a violation requires removing its fingerprint
 * (and deleting the file from both this map and .oxlintrc.json overrides once empty). */
export const LEGACY_NESTED_TERNARY_BASELINE: NestedTernaryBaseline = {
  "browser/display/owner.ts": ["d9dfd8a733bf"],
  "browser/gpu/codec.ts": ["477e24b64ba0", "7beab5e6aef2", "905339b25525"],
  "browser/gpu/guest.ts": ["674ba202c89a"],
  "browser/gpu/metadata.ts": ["477e24b64ba0", "905339b25525"],
  "browser/gpu/replay.ts": ["a5cc9079b64e", "b51b5d8ed02c", "f9e50be600a5"],
  "browser/gpu/service.ts": ["0c3940a53436"],
  "browser/guarded-stream.ts": ["6d7861cada7f"],
  "browser/net/helper.ts": ["b75f3b14f040"],
  "browser/net/namespace.ts": ["359bf4c812b5"],
  "browser/operations/guest.ts": ["53326dc2c9bd"],
  "browser/operations/owner.ts": ["b6ad296b3d44"],
  "browser/operations/writer.ts": ["e122287fcf08"],
  "browser/preview1-socket.ts": ["abc05eac0f13"],
  "browser/process-broker.ts": [
    "059a9d63a25c",
    "295505fdf602",
    "44b64851a768",
    "4f0366c95884",
    "86d9988223e1",
    "df84011b16c1",
    "e85d2d37b11e",
    "ffc680da1fe7",
  ],
  "browser/terminal-session.ts": ["7f90beee02e7", "f0bb553c0ad7"],
  "browser/worker.ts": [
    "003353858527",
    "5f8ee8bb518e",
    "75cc1d229f5e",
    "a868be9b3e88",
    "ae3455a44bda",
    "eda0102d2c3e",
  ],
  "core/wasi.ts": [
    "2a9a5f26171c",
    "3776eca1866f",
    "585e56e83a6b",
    "62af726ed01b",
    "72d8b34df834",
    "89fde7b282bd",
    "8de3d5dd3c2d",
    "a343834d4e67",
    "a407535af8bc",
    "a962aa0f5bc9",
    "c59ca430fba2",
    "d3b2fac2b189",
    "d759d1572d1a",
    "e01cd1dd3360",
    "e52f2a3e197c",
    "f3b6d8d68227",
  ],
  "fs/backend.ts": ["9d2cea3590cb", "ab1c8c36507e"],
  "fs/client.ts": ["474881ac1dcd", "ceb5e7a8ba70"],
  "fs/directory-pages.ts": ["6a46bcb2aea2", "a206b64bbb40"],
  "fs/identity-allocation.ts": ["c5f0286d676c"],
  "fs/idle-owner.ts": ["84e527cfcf4b"],
  "fs/indexeddb.ts": ["4b95d4f461c6", "c49d123efbf5"],
  "fs/memory.ts": ["cbb528abbab1", "cbb528abbab1"],
  "fs/multitab-backend.ts": ["a86f82e40c57"],
  "fs/namespace-projection-table.ts": [
    "2ee0757b676a",
    "35ea3e36314c",
    "486b02c5bdda",
    "670986294eef",
    "8b9055a96153",
    "bded8c376d13",
    "bded8c376d13",
    "d4f7cc63786f",
    "dc36cb46e4a0",
  ],
  "fs/opfs.ts": ["0cae557098d4", "1a5b8053866c"],
  "fs/persistent.ts": ["534214efb92d", "60f16c57b23a", "61df4da4d732", "e59aaeaf7c67"],
  "fs/publication-attachment.ts": ["90ffe17f4cc3"],
  "fs/request-memory.ts": ["332da59d1fa2", "3b48652a50a1", "eb24bbc56b7e"],
  "fs/service.ts": ["36dfa35516b2", "50a0524f3dc6", "656a18b830d1", "842f45e764a9"],
  "fs/shared.ts": ["29d4724fe50a", "8dbd6807bf11", "b2f185333ddf", "e0d95491d4e3"],
  "fs/watch-ring.ts": ["da7f9bc36982"],
  "fs/watch-service.ts": ["4f9effacf5fc", "6b9a98be1660"],
  "fs/workspace-archive.ts": ["1cade65e3150", "974219cc7063", "b1438192d7fe"],
  "fs/workspace.ts": ["006190304d73", "f88258249be1"],
  "group/member.ts": ["e6c96d78f490"],
  "interrupt/wait.ts": ["710e13c4fc2f"],
  "memory/declarations.ts": ["530bacde8003"],
  "proc/abi.ts": ["6279ef29cf06", "7bcf49c6ef07", "cb2bb7cd2723"],
  "proc/access.ts": ["4fbb71aa8613", "671b7cee203a", "6740f82a235b", "f72a018eddf7"],
  "proc/command-stdio.ts": ["1925f49bc0cb", "da9af5738663"],
  "proc/directory.ts": ["502357cce28f"],
  "proc/node-wasi.ts": ["6f13e0908639", "db41f8f0c55f", "ee05c088092b", "f80108589ddf"],
  "proc/observation.ts": ["4904d0210c7c"],
  "proc/outcome.ts": ["4904d0210c7c", "5fb69f659de4"],
  "proc/registry.ts": ["57cb9b98826b", "a82f5205d826", "d1687b733dc5"],
  "proc/signals.ts": ["ab4e1f425dd3"],
  "proc/start-diagnostic.ts": ["e54ad5426c74"],
  "proc/start-failure.ts": ["72d59209524d", "bbe6e2001397", "c3129a923c53"],
  "proc/supervisor.ts": ["1d43cd074d80"],
  "proc/wait-status.ts": ["9b6cd3cf426d"],
  "proc/worker-broker.ts": ["0d44e3138a23", "a3b44edcf5eb"],
  "proc/worker-pipes.ts": ["46291e706f26"],
  "search/engine.ts": ["decbb0ca78ee"],
  "testing/indexeddb-storage-browser.ts": ["d9682ef1273e"],
  "testing/page-runner/bootstrap-diagnostics.ts": ["8cad020bff6e"],
  "testing/page-runner/browser-observation.ts": ["e47d32879095", "fc15b7e5517f"],
  "testing/page-runner/framework-queue.ts": ["92a33b877724", "f66c7bea682f"],
  "testing/page-runner/framework-trace.ts": ["4fceb956e4b7", "62ff0fb97ad3", "9ca75489fcd6"],
  "testing/page-runner/host-drive.ts": ["8eed82937c98"],
  "testing/page-runner/inspector-plist.ts": ["a37746b77865"],
  "testing/page-runner/safari-driver.ts": ["a53e2c87a629", "fe9a8dc67469"],
  "testing/page-runner/suite-host.ts": [
    "391934cd80a8",
    "5ff3fe373798",
    "a44b6a910237",
    "cbbe565b7d92",
    "d96b8aa3bb01",
    "f9a006c96d36",
  ],
  "testing/storage-navigation-diagnostics.ts": ["2ad106c33af3"],
  "tests/browser-matrix.test.ts": ["1a198bf86017", "6ad83cb3694c", "d2a86c5ec27b", "d38f88c67da4"],
  "tests/browser-worker.test.ts": ["ecf1ddb8c387", "ecf1ddb8c387"],
  "tests/c-threads-safari-runner.ts": ["613e3458c993", "f4e4f858413a"],
  "tests/filesystem-retired-release.test.ts": ["686c6ee9c2ea"],
  "tests/filesystem-shutdown-close-observation.test.ts": ["6219c5d564ea"],
  "tests/filesystem-shutdown.test.ts": ["173412c29266"],
  "tests/fixtures/default-allocation-capture.ts": ["964fb1aaa6df"],
  "tests/fixtures/descendant-real-worker.ts": ["343d7c9ac803", "c411ef9f0979"],
  "tests/fixtures/gpu/async-host.ts": ["a5d69c3ed227"],
  "tests/fixtures/gpu/async-native.ts": ["da52f7d63eec"],
  "tests/fixtures/gpu/bundle-query-native.ts": ["2550aa8756df"],
  "tests/fixtures/gpu/compute-native.ts": ["5fd08d1f6584"],
  "tests/fixtures/gpu/copy-draw-native.ts": [
    "3380e250b190",
    "5ec2ac83da46",
    "8341c7399be2",
    "8b3faec6640b",
  ],
  "tests/fixtures/gpu/integration-guest.ts": ["ef6a4ea21627"],
  "tests/fixtures/gpu/integration-service-worker.ts": ["b5d48ef3b1f5", "eb2329456167"],
  "tests/fixtures/gpu/ownership-service-worker.ts": [
    "529f3f66bc1e",
    "b5aa14c335e3",
    "bca3002c94f4",
    "e45fd3abe4ad",
  ],
  "tests/fixtures/gpu/ring-worker.ts": ["7e54d3689b56"],
  "tests/fixtures/gpu/scene-native.ts": ["02c781e7146d"],
  "tests/fixtures/interrupt-symbols-worker.ts": ["927877f9482b"],
  "tests/fixtures/nested-wasi.ts": ["265074efea97"],
  "tests/fixtures/search-count-worker.ts": ["35d7ec223a46"],
  "tests/fixtures/shared-caller-exec.ts": ["121ee9fca664", "e6bb5a11c976"],
  "tests/fixtures/vfs-backends.ts": ["4f4bd7940c20"],
  "tests/fixtures/vfs-fd-conformance-worker.ts": ["3a22e0b76440", "a1f8d9962b74"],
  "tests/gpu-admission-browser.ts": ["22f05e4e8596"],
  "tests/gpu-admission-controls.test.ts": [
    "00a968eea618",
    "0cfc72e1cd45",
    "193abc356b60",
    "e77a188c89c5",
  ],
  "tests/gpu-async-command.test.ts": ["6e29fdc7f333", "9d0617f6733f"],
  "tests/gpu-async-command.ts": ["f3631d18c075"],
  "tests/gpu-async-fixture.test.ts": ["a054973dd099"],
  "tests/gpu-async-payload.test.ts": ["24eae881c1d9"],
  "tests/gpu-browser-shared.ts": ["0d06725dede3"],
  "tests/gpu-ci.test.ts": ["a9c7f84dc713", "f6ccabb2a566"],
  "tests/gpu-copy-draw-replay.test.ts": ["00562ba306bf"],
  "tests/gpu-desktop-measure.test.ts": ["0c54af88f953"],
  "tests/gpu-disposal-controls.test.ts": ["29727d2dfbb4", "ddd30338d516"],
  "tests/gpu-grant-quota-browser.ts": ["0187fa5df49f"],
  "tests/gpu-grant-quota-controls.test.ts": ["ae95145f2a8f", "cb5cd119229e"],
  "tests/gpu-malformed-browser.ts": ["75bdc91a6891", "92be1f6f605a", "b5aa14c335e3"],
  "tests/gpu-malformed-controls.test.ts": ["0ebf7cc52a88", "1565b732d37b", "19bab7295f7c"],
  "tests/gpu-native-controls.test.ts": ["b68b4c93acc7"],
  "tests/gpu-ownership-controls.test.ts": ["0abcd31f1e46"],
  "tests/gpu-payload-pressure-browser.ts": [
    "2731a8d11596",
    "3aca4c21cc71",
    "751acb48e16d",
    "e33d1dfcd08a",
  ],
  "tests/gpu-payload-pressure-controls.test.ts": [
    "3dd9b071ab95",
    "8af9f937ee07",
    "93c6d9bae508",
    "a3f3fcd20bfb",
    "a3f3fcd20bfb",
    "bceea3ad34b0",
    "c085fd31e0b7",
    "f1bcff6a2767",
  ],
  "tests/gpu-regrant-controls.test.ts": [
    "0b24f053d3bb",
    "4620c7bb9c48",
    "6a2ace9b3e3c",
    "c1e3217feeaa",
    "eb9a5b0c405e",
  ],
  "tests/gpu-replay.test.ts": ["1bb9e824b831"],
  "tests/gpu-service-failure-browser.ts": ["f1c8d81d2bc5"],
  "tests/gpu-service-failure-controls.test.ts": ["d08b75e68f13"],
  "tests/indexeddb-chunks-browser.ts": ["c6dbe3057e8f"],
  "tests/indexeddb-chunks.test.ts": ["f15f05af421a"],
  "tests/installer-symlinks-borrow.test.ts": ["4dea96ae8d7f"],
  "tests/installer-symlinks-readlink.test.ts": ["4dea96ae8d7f"],
  "tests/interrupt-wait-profile.test.ts": ["877081278397"],
  "tests/link-program.test.ts": ["61c50c795fdc"],
  "tests/memory-budget.test.ts": ["4db132160dac"],
  "tests/namespace-projection-table.test.ts": ["2ab0f5aab468", "eea949c11e9d"],
  "tests/network-address.test.ts": ["fad46e7eb296"],
  "tests/notification-command.ts": ["114ae7be4522"],
  "tests/notification-lifetime-cases.ts": ["6f18afd444e7"],
  "tests/operation-diagnostics-browser.ts": ["1ead7b5ea2d1"],
  "tests/page-runner/asset-owner.test.ts": ["693ca06a0c78"],
  "tests/page-runner/bootstrap-diagnostics.test.ts": ["3ca8db37fd5f", "c570c6bb3747"],
  "tests/page-runner/browser-controls-runner.ts": ["11a9615ac56e", "acec42942e6b"],
  "tests/page-runner/collector.test.ts": ["254c16914760"],
  "tests/page-runner/command-controls.ts": ["102a1dd76866", "1602172d3450", "20d778cf312e"],
  "tests/page-runner/consumer-controls.ts": ["6da831b3e5de"],
  "tests/page-runner/framework-host.test.ts": ["de6f56953935", "de6f56953935"],
  "tests/page-runner/gpu-async-failure-controls.ts": ["69526752d17c"],
  "tests/page-runner/host-drive-controls.ts": ["1469bdcca446", "4255bc016f6c", "adde5c4fc8af"],
  "tests/page-runner/host-drive.test.ts": ["d4835ee92be5"],
  "tests/page-runner/host-storage-controls.ts": ["acde9a9712cd"],
  "tests/page-runner/peer-controls.ts": ["9e9a9516f9ac"],
  "tests/page-runner/process-recycling-controls.ts": ["4471a98f0783", "5ae0a89118ef"],
  "tests/page-runner/publication-cross-tab-host.ts": ["60534c03abfe"],
  "tests/page-runner/reporter-control-failure.test.ts": ["812ef6362ed8"],
  "tests/page-runner/reporter-control-page.ts": ["999e7e0307dd"],
  "tests/page-runner/safari-driver.test.ts": ["d5392883b7aa"],
  "tests/page-runner/safari-observer.test.ts": ["aa97a5211777"],
  "tests/page-runner/threads-runtime-suite.test.ts": ["7e5785aca3e1"],
  "tests/page-runner/threads-runtime-suite.ts": ["7e5785aca3e1"],
  "tests/preview1-network-launch.test.ts": ["1841ad99863f", "383c988b121d"],
  "tests/process-abi.test.ts": ["a0de6dc327dd", "bd416a3c045f", "f0c09f7f2ecf"],
  "tests/process-access.test.ts": ["46ea8340df58"],
  "tests/process-admission.test.ts": ["eac2e1c51ada"],
  "tests/process-execve.test.ts": ["7fff18042296", "7fff18042296", "a0036cb31447", "c79461029773"],
  "tests/process-navigation-observer.test.ts": ["82bd09b02b36", "c41c7c3b9ddb"],
  "tests/process-quiescence.test.ts": ["a4c3fd90d05c"],
  "tests/process-root-navigation-diagnostic.ts": ["8ce30894313f", "c5f59671d717"],
  "tests/process-spawn-errno.test.ts": ["eb0ba087b3bf"],
  "tests/process-start-failed.test.ts": ["7815f40e3023", "bca456129038"],
  "tests/process-worker-ownership.test.ts": ["0fbbb4e8a6bc", "5c571ae03aed"],
  "tests/search-program-browser-runner.ts": ["02b4200cfa6e", "0d1bd1bae80f", "dae98b417f85"],
  "tests/sender-admission.test.ts": ["61ac5876883f"],
  "tests/start-failure-quiet-browser.ts": ["300fc4f0b58d", "d893fbd09e2e"],
  "tests/storage-crash-r2-opfs.ts": ["21304757ca18"],
  "tests/storage-lock-browser-runner.ts": ["2f670e05f944", "55806d885f63"],
  "tests/storage-lock-browser.ts": ["27eedd3828d4"],
  "tests/storage-quota-r2-probes.ts": ["a873c87efeaf"],
  "tests/threads-fdstat.test.ts": ["3c13c228066d", "9cda8af44be1"],
  "tests/threads-lifecycle-module.ts": ["1c7bed117fba", "9569dd7dc498"],
  "tests/threads-runtime-browser.ts": ["325ffea70007", "818e5e023a93"],
  "tests/threads-runtime-modules.ts": ["b1de7167d003"],
  "tests/threads-runtime-safari-runner.ts": ["613e3458c993", "f7a6a802b7ae"],
  "tests/threads-safari-runner.ts": ["613e3458c993", "8e5f4a3e47eb"],
  "tests/watch-root-runtime.test.ts": ["6c22db4e8c6a"],
  "tests/workspace-archive-pulls.test.ts": ["ef76bce5084b"],
  "tests/workspace-export.test.ts": ["8c2571959741"],
  "tests/workspace-safari-runner.test.ts": ["05d82375903d", "0620cc9cbd2c"],
  "tests/workspace-vfs-read-stream.test.ts": ["b8f29a91e5fe"],
  "tests/workspace-vfs-read.test.ts": [
    "61da9a8fd6a6",
    "7bd8962c0b02",
    "8b3610766eb5",
    "cc44da987cc3",
  ],
  "thread/guest-imports.ts": ["3f63407dfd98", "7ab218c5a4cf", "cc76dd356042", "d443b57ad5c0"],
  "thread/service.ts": [
    "2106a5faea94",
    "658cd9799600",
    "9bd0b958c84f",
    "ad1650947e05",
    "b741e122d2ba",
  ],
  "tooling/gpu-measure.ts": ["06ce64770cf5", "5efb9cc8d78b", "6cd437300fe1"],
  "tooling/gpu-stream.ts": ["07c1bb83e1c1", "6ed9863b9a11", "df041918d9c7", "df460e8650fa"],
  "tooling/private-authority.ts": ["19d07f2a4488"],
  "tooling/vfs-benchmark.ts": ["5e6c648ea88d"],
  "tooling/vfs-score-config.ts": ["971915afe604"],
  "tooling/vfs-score.ts": ["8b56f77bbd3b"],
  "tooling/vfs-workloads.ts": ["973659d662e5", "cfb7afd8990a"],
  "tooling/workspace-safari-runner.ts": ["13aee900bf3a", "1d1886695a54"],
};

interface OxlintConfig {
  overrides?: {
    files?: string[];
    rules?: Record<string, unknown>;
  }[];
}

interface OxlintDiagnostic {
  code?: string;
  filename?: string;
  labels?: { span?: { offset: number; length: number } }[];
}

const tsTranspiler = new Bun.Transpiler({
  loader: "ts",
  trimUnusedImports: false,
  deadCodeElimination: false,
  inline: false,
});

export function fingerprintExpression(source: string): string {
  const normalized = tsTranspiler
    .transformSync(`class _ extends Object { async *m() { (${source}); } }`)
    .trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

function readOverrideFiles(root: string): { files: string[]; errors: string[] } {
  const errors: string[] = [];
  const raw = readFileSync(join(root, ".oxlintrc.json"), "utf8");
  const config = Bun.JSONC.parse(raw) as OxlintConfig;
  const matching = (config.overrides ?? []).filter(
    (entry) => entry.rules && entry.rules["no-nested-ternary"] === "off",
  );
  if (matching.length > 1) {
    errors.push("expected at most one no-nested-ternary override entry in .oxlintrc.json");
  }
  const files: string[] = [];
  const seen = new Set<string>();
  for (const entry of matching) {
    for (const file of entry.files ?? []) {
      if (seen.has(file)) {
        errors.push(`duplicate no-nested-ternary override entry: ${file}`);
        continue;
      }
      seen.add(file);
      files.push(file);
    }
  }
  return { files, errors };
}

function validateBaselineAlignment(
  overrideFiles: readonly string[],
  baseline: NestedTernaryBaseline,
): string[] {
  const errors: string[] = [];
  const overrideSet = new Set(overrideFiles);
  for (const file of overrideFiles) {
    const list = baseline[file];
    if (!list || list.length === 0) {
      errors.push(
        `.oxlintrc.json override ${file} has no entries in LEGACY_NESTED_TERNARY_BASELINE`,
      );
    }
  }
  for (const [file, list] of Object.entries(baseline)) {
    if (list.length === 0) {
      errors.push(`empty baseline entry for ${file} — remove from LEGACY_NESTED_TERNARY_BASELINE`);
    }
    if (!overrideSet.has(file)) {
      errors.push(`baseline entry ${file} is missing from .oxlintrc.json overrides`);
    }
  }
  return errors;
}

function countBag(items: readonly string[]): Map<string, number> {
  const bag = new Map<string, number>();
  for (const item of items) bag.set(item, (bag.get(item) ?? 0) + 1);
  return bag;
}

/** Verify a PR baseline never adds new files or fingerprints compared to a base ref baseline. */
export function checkBaselineMonotonic(
  previous: NestedTernaryBaseline,
  current: NestedTernaryBaseline,
): string[] {
  const findings: string[] = [];
  for (const [file, list] of Object.entries(current)) {
    const prevList = previous[file];
    if (!prevList) {
      findings.push(`baseline grew: added file ${file} to LEGACY_NESTED_TERNARY_BASELINE`);
      continue;
    }
    const prevBag = countBag(prevList);
    const currBag = countBag(list);
    for (const [fp, count] of currBag) {
      const allowed = prevBag.get(fp) ?? 0;
      if (count > allowed) {
        findings.push(
          `baseline grew in ${file}: added nested-ternary fingerprint ${fp} (was ${allowed}, now ${count})`,
        );
      }
    }
  }
  return findings;
}

export function loadBaseBaseline(
  root: string,
  baseRef: string,
): { baseline?: NestedTernaryBaseline; error?: string } {
  const verify = Bun.spawnSync(["git", "rev-parse", "--verify", `origin/${baseRef}`], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (verify.exitCode !== 0) {
    return {
      error: `monotonic baseline check failed: git ref origin/${baseRef} is unavailable (fetch origin/${baseRef} first)`,
    };
  }
  const spec = `origin/${baseRef}:packages/waffle/tooling/nested-ternary-baseline.ts`;
  const exists = Bun.spawnSync(["git", "cat-file", "-e", spec], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (exists.exitCode !== 0) return {};
  const proc = Bun.spawnSync(["git", "show", spec], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    return { error: `monotonic baseline check failed: could not read ${spec}` };
  }
  const text = proc.stdout.toString();
  const match =
    /LEGACY_NESTED_TERNARY_BASELINE:\s*NestedTernaryBaseline\s*=\s*(\{[\s\S]*?\n\});/.exec(text);
  if (!match) {
    return { error: `monotonic baseline check failed: could not parse baseline in ${spec}` };
  }
  return {
    baseline: Bun.JSONC.parse(match[1]!.replace(/,\s*([}\]])/g, "$1")) as NestedTernaryBaseline,
  };
}

function collectActualFingerprints(
  root: string,
  files: readonly string[],
  oxlintBin: string,
): { byFile: Map<string, string[]>; error?: string } {
  const byFile = new Map<string, string[]>();
  if (files.length === 0) return { byFile };
  const dir = mkdtempSync(join(tmpdir(), "waffle-nt-config-"));
  const configPath = join(dir, "strict.json");
  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        categories: { correctness: "off" },
        rules: { "no-nested-ternary": "error" },
      }),
    );
    const proc = Bun.spawnSync(
      [oxlintBin, "--config", configPath, "--format", "json"].concat(files),
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = proc.stdout.toString();
    if (!stdout.trim()) {
      return {
        byFile,
        error: `oxlint failed without JSON output: ${proc.stderr.toString().trim()}`,
      };
    }
    const parsed = JSON.parse(stdout) as { diagnostics?: OxlintDiagnostic[] };
    const sourceCache = new Map<string, Buffer>();
    for (const diagnostic of parsed.diagnostics ?? []) {
      if (diagnostic.code !== "eslint(no-nested-ternary)" || !diagnostic.filename) continue;
      const normalized = diagnostic.filename.replaceAll("\\", "/");
      const span = diagnostic.labels?.[0]?.span;
      if (!span) continue;
      let source = sourceCache.get(normalized);
      if (source === undefined) {
        source = readFileSync(join(root, normalized));
        sourceCache.set(normalized, source);
      }
      const snippet = source.subarray(span.offset, span.offset + span.length).toString("utf8");
      const fp = fingerprintExpression(snippet);
      const list = byFile.get(normalized);
      if (list) list.push(fp);
      else byFile.set(normalized, [fp]);
    }
    return { byFile };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function checkNestedTernaryBaseline(
  root: string,
  baseline: NestedTernaryBaseline = LEGACY_NESTED_TERNARY_BASELINE,
  oxlintBin = join(root, "node_modules/.bin/oxlint"),
): string[] {
  const { files, errors } = readOverrideFiles(root);
  const alignment = validateBaselineAlignment(files, baseline);
  if (errors.length > 0 || alignment.length > 0) return errors.concat(alignment);

  const missing = files.filter((file) => !existsSync(join(root, file)));
  if (missing.length > 0) {
    return missing.map(
      (file) =>
        `deleted legacy file ${file} is still listed — remove from LEGACY_NESTED_TERNARY_BASELINE and .oxlintrc.json overrides`,
    );
  }

  const actual = collectActualFingerprints(root, files, oxlintBin);
  if (actual.error) return [actual.error];

  const findings: string[] = [];
  for (const file of files) {
    const expectedBag = countBag(baseline[file]!);
    const actualList = actual.byFile.get(file) ?? [];
    const actualBag = countBag(actualList);
    for (const [fp, count] of actualBag) {
      const allowed = expectedBag.get(fp) ?? 0;
      if (count > allowed) {
        findings.push(
          `new nested ternary violation(s) in legacy file ${file} (fingerprint ${fp}: expected ${allowed}, found ${count}) — refactor instead of adding nested ternaries`,
        );
      }
    }
    for (const [fp, expected] of expectedBag) {
      const found = actualBag.get(fp) ?? 0;
      if (found < expected) {
        const suffix = actualList.length === 0 ? " and remove from .oxlintrc.json overrides" : "";
        findings.push(
          `legacy baseline for ${file} can shrink (fingerprint ${fp}: expected ${expected}, found ${found}) — update LEGACY_NESTED_TERNARY_BASELINE${suffix}`,
        );
      }
    }
  }
  return findings;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const findings = checkNestedTernaryBaseline(root);
  const baseRef = process.env.GITHUB_BASE_REF;
  if (baseRef) {
    const previous = loadBaseBaseline(root, baseRef);
    if (previous.error) findings.push(previous.error);
    else if (previous.baseline) {
      findings.push(...checkBaselineMonotonic(previous.baseline, LEGACY_NESTED_TERNARY_BASELINE));
    }
  }
  if (findings.length > 0) {
    for (const finding of findings) console.error(finding);
    process.exit(1);
  }
}
