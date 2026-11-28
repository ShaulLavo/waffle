import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type NestedTernaryBaseline = Readonly<Record<string, readonly string[]>>;

/** Pre-existing legacy nested-ternary expression fingerprints per file (12-char SHA-256 of
 * exact UTF-8 diagnostic span bytes; formatting is already canonicalized by oxfmt). Baseline
 * only shrinks: adding or modifying a nested ternary in a listed file fails lint, and removing a
 * violation requires removing its fingerprint (and deleting the file from both this map and
 * .oxlintrc.json overrides once empty). */
export const LEGACY_NESTED_TERNARY_BASELINE: NestedTernaryBaseline = {
  "browser/display/owner.ts": ["ab4a8a214bd0"],
  "browser/gpu/codec.ts": ["3bd64f744394", "6a7c25e8718a", "bc32706d9322"],
  "browser/gpu/guest.ts": ["2e52b90f64ed"],
  "browser/gpu/metadata.ts": ["3bd64f744394", "bc32706d9322"],
  "browser/gpu/replay.ts": ["02cb21d8b5c2", "3e32f237e95a", "b11dd6202124"],
  "browser/gpu/service.ts": ["9dcbecf9774e"],
  "browser/guarded-stream.ts": ["96e8768a99c2"],
  "browser/net/helper.ts": ["318c4c0b70ed"],
  "browser/net/namespace.ts": ["0bb2987e34db"],
  "browser/operations/guest.ts": ["c3c6552caff5"],
  "browser/operations/owner.ts": ["5abd5d5878a7"],
  "browser/operations/writer.ts": ["a054a4c47dbc"],
  "browser/preview1-socket.ts": ["3b96ab8df37d"],
  "browser/process-broker.ts": [
    "0022dee2bc77",
    "451f0530bc08",
    "55625b20b7c6",
    "7498a99ecb10",
    "d4437c5244b7",
    "daa798f35230",
    "e35f9267ee19",
    "f41c59f60a44",
  ],
  "browser/terminal-session.ts": ["6ed0c9225ac8", "904eb3fcd552"],
  "browser/worker.ts": [
    "2ddaf5649a6e",
    "68c8ffb41617",
    "8da17f239a06",
    "8f2a776531a7",
    "bb4e546b2be2",
    "d80eacf38902",
  ],
  "core/wasi.ts": [
    "0fc75e5038fb",
    "70148179c619",
    "88b1bc9da82d",
    "aea9c3532a7d",
    "ca2c3a953900",
    "d2abd477fe94",
    "f51bac71589e",
    "fe7462a9611a",
  ],
  "fs/backend.ts": ["580e1380ca39", "f8484dfcce6a"],
  "fs/client.ts": ["204e2ebe1a4e", "6772a8e8ec7d"],
  "fs/directory-pages.ts": ["585589a65342", "ba61368c9638"],
  "fs/identity-allocation.ts": ["abfaa776ef95"],
  "fs/idle-owner.ts": ["d1b2f3fcb564"],
  "fs/indexeddb.ts": ["694e4b956a42", "f83036b0cea8"],
  "fs/memory.ts": ["5e4c7c9a9b55", "5e4c7c9a9b55"],
  "fs/multitab-backend.ts": ["67af7fcfcab8"],
  "fs/namespace-projection-table.ts": [
    "3ea328cd7d1e",
    "4302c144e5dd",
    "625d0c10e23d",
    "6af113e230e3",
    "9e3235b1d500",
    "d0ec0d048019",
    "d0ec0d048019",
    "d3f7ac053a6a",
    "f0325bd39c6d",
  ],
  "fs/opfs.ts": ["82c418c62a43", "abca47650a67"],
  "fs/persistent.ts": ["77ec706c11e6", "91bcf83513b7", "b05d577cdbd5", "fb72c29ebddc"],
  "fs/publication-attachment.ts": ["af44948c07a6"],
  "fs/request-memory.ts": ["0a46e82554ed", "95bc1a73995d", "ddd291211931"],
  "fs/service.ts": ["17c91650026e", "222cfff57a0d", "9cb6b5331596", "ab8c38e5a46f"],
  "fs/shared.ts": ["a66b222226d1", "b790ffaa3bce", "dc714ab37485", "df8b87ad6a34"],
  "fs/watch-ring.ts": ["c5b2f07db3ee"],
  "fs/watch-service.ts": ["220ec27a4d25", "377a8ff7b240"],
  "fs/workspace-archive.ts": ["0ef8f043eedf", "602f3178ed22", "ec34b085e5a8"],
  "fs/workspace.ts": ["98c0ba99a9c5", "e1155f847f92"],
  "group/member.ts": ["e19dae469c01"],
  "interrupt/wait.ts": ["09c7d33f72a6"],
  "memory/declarations.ts": ["f2e13226bfad"],
  "proc/abi.ts": ["4da3eaf99b09", "a4c9670b0376", "a5ccaafe43f6"],
  "proc/access.ts": ["3f2970128f2a", "541be76a1439", "750e7b1fb77c", "78116993f921"],
  "proc/command-stdio.ts": ["4d565fd49ac6", "e76f2b329448"],
  "proc/directory.ts": ["2ecdd768502b"],
  "proc/node-wasi.ts": ["161e459946b4", "5981356ef7d7", "e26cd0ee1a55"],
  "proc/observation.ts": ["5840a29a354c"],
  "proc/outcome.ts": ["5840a29a354c", "e29c00d88bc6"],
  "proc/registry.ts": ["153fe84c3ab3", "1ef7e706acec", "a5a12cb1e348"],
  "proc/signals.ts": ["20536a6c4657"],
  "proc/start-diagnostic.ts": ["493f28040dd5"],
  "proc/start-failure.ts": ["3ec9a9927d44", "59d5ddf83429", "716399ff0a2b"],
  "proc/supervisor.ts": ["cc3f679f36cc"],
  "proc/wait-status.ts": ["2c7fc3986172"],
  "proc/worker-broker.ts": ["5973591e7274", "6546207ddc2e"],
  "proc/worker-pipes.ts": ["c03353f225e3"],
  "search/engine.ts": ["077277c4f96b"],
  "testing/indexeddb-storage-browser.ts": ["cd57345692d6"],
  "testing/page-runner/bootstrap-diagnostics.ts": ["544a1976f492"],
  "testing/page-runner/browser-observation.ts": ["894a3de0ea92", "a9ed0e5f3290"],
  "testing/page-runner/framework-queue.ts": ["4ec5992a48e6", "9a0bb537fa19"],
  "testing/page-runner/framework-trace.ts": ["1ddfc4e4e23f", "64d5e18faab4", "c772a2c79457"],
  "testing/page-runner/host-drive.ts": ["f966f88b21a4"],
  "testing/page-runner/inspector-plist.ts": ["f513f2a61955"],
  "testing/page-runner/safari-driver.ts": ["8278be48f62c", "b3de31dbb976"],
  "testing/page-runner/suite-host.ts": [
    "082897115095",
    "173cb53a17a7",
    "33b6de1f9392",
    "42b64420122d",
    "8ba1c2648d06",
    "fc9073e9ebc3",
  ],
  "testing/storage-navigation-diagnostics.ts": ["1c5d1a25aedd"],
  "tests/browser-matrix.test.ts": ["22263d6b73f9", "2a312250f6b0", "bbd551604411", "e900769348fa"],
  "tests/browser-worker.test.ts": ["1df216578e79", "1df216578e79"],
  "tests/c-threads-safari-runner.ts": ["61e683c795f4", "bb73cd9c54b4"],
  "tests/filesystem-retired-release.test.ts": ["691f97de542f"],
  "tests/filesystem-shutdown-close-observation.test.ts": ["e5f53bb97503"],
  "tests/filesystem-shutdown.test.ts": ["f4e20a227139"],
  "tests/fixtures/default-allocation-capture.ts": ["9e80393b4262"],
  "tests/fixtures/descendant-real-worker.ts": ["54e370565824", "c1e77b7b3105"],
  "tests/fixtures/gpu/async-host.ts": ["3258532ed775"],
  "tests/fixtures/gpu/async-native.ts": ["3a4015f120f6"],
  "tests/fixtures/gpu/bundle-query-native.ts": ["0884f9f22fe2"],
  "tests/fixtures/gpu/compute-native.ts": ["c5037fd376f8"],
  "tests/fixtures/gpu/copy-draw-native.ts": [
    "922770e073e0",
    "be3b02ec00b7",
    "c7c94b8c59b6",
    "fd1adf643443",
  ],
  "tests/fixtures/gpu/integration-guest.ts": ["4c0dd419ca28"],
  "tests/fixtures/gpu/integration-service-worker.ts": ["ad4a10d16242", "e956a8cb88e4"],
  "tests/fixtures/gpu/ownership-service-worker.ts": [
    "09210de30440",
    "b71a9ef41a0f",
    "d3113b9c2e83",
    "db9447bd02de",
  ],
  "tests/fixtures/gpu/ring-worker.ts": ["92fc8282d094"],
  "tests/fixtures/gpu/scene-native.ts": ["08138797ed80"],
  "tests/fixtures/interrupt-symbols-worker.ts": ["02377f08fa14"],
  "tests/fixtures/nested-wasi.ts": ["1e34523230ea"],
  "tests/fixtures/search-count-worker.ts": ["084ec38cb1c0"],
  "tests/fixtures/shared-caller-exec.ts": ["0958835bb2fb", "d19b181b1ea8"],
  "tests/fixtures/vfs-backends.ts": ["535e5193c529"],
  "tests/fixtures/vfs-fd-conformance-worker.ts": ["97f5098e060a", "fabc09eb3df1"],
  "tests/gpu-admission-browser.ts": ["33bfaf1f3b96"],
  "tests/gpu-admission-controls.test.ts": [
    "00a82def53c0",
    "a7e2e4e3b258",
    "a8db8013161c",
    "d76219f59f9e",
  ],
  "tests/gpu-async-command.test.ts": ["8543e3aecc0c", "d14774117355"],
  "tests/gpu-async-command.ts": ["92e44acaf47a"],
  "tests/gpu-async-fixture.test.ts": ["8f835ec4876d"],
  "tests/gpu-async-payload.test.ts": ["e81b3f3c09b3"],
  "tests/gpu-browser-shared.ts": ["1746c6fed546"],
  "tests/gpu-ci.test.ts": ["1b109e435ba7", "db9e05055a95"],
  "tests/gpu-copy-draw-replay.test.ts": ["6e9c684d499b"],
  "tests/gpu-desktop-measure.test.ts": ["058c2fb214e7"],
  "tests/gpu-disposal-controls.test.ts": ["5bf163d50829", "fcfd35af21b7"],
  "tests/gpu-grant-quota-browser.ts": ["97fbbe9ddda7"],
  "tests/gpu-grant-quota-controls.test.ts": ["1628e51d58c0", "50ef764c466c"],
  "tests/gpu-malformed-browser.ts": ["15c750849f79", "b4cded221478", "d3113b9c2e83"],
  "tests/gpu-malformed-controls.test.ts": ["25b223849bcd", "9a9a7f21ef4f", "9acddb6ff978"],
  "tests/gpu-native-controls.test.ts": ["9f11d3a67194"],
  "tests/gpu-ownership-controls.test.ts": ["9d1865f907e3"],
  "tests/gpu-payload-pressure-browser.ts": [
    "3f2ed3433553",
    "aade18c133cb",
    "af0365c8c700",
    "fba1caab0ec9",
  ],
  "tests/gpu-payload-pressure-controls.test.ts": [
    "2e6bfc17942e",
    "4392038b6592",
    "504911a46397",
    "504911a46397",
    "563b4e6771bc",
    "574916a721fd",
    "64a91cfd0f6f",
    "f17b7c7aa9e2",
  ],
  "tests/gpu-regrant-controls.test.ts": [
    "2d68f98ba10c",
    "48cca1e126eb",
    "a6d687df9fcf",
    "b86ce6f2d948",
    "dafde5efc274",
  ],
  "tests/gpu-replay.test.ts": ["f50704b5de78"],
  "tests/gpu-service-failure-browser.ts": ["fb948a842c7d"],
  "tests/gpu-service-failure-controls.test.ts": ["580398a08b19"],
  "tests/indexeddb-chunks-browser.ts": ["d4bb29a30d3d"],
  "tests/indexeddb-chunks.test.ts": ["b0fd6ae3cc6b"],
  "tests/installer-symlinks-borrow.test.ts": ["624dd6e10e5f"],
  "tests/installer-symlinks-readlink.test.ts": ["624dd6e10e5f"],
  "tests/interrupt-wait-profile.test.ts": ["841f8d3c5f29"],
  "tests/link-program.test.ts": ["202ced5d666c"],
  "tests/memory-budget.test.ts": ["3211e66449d2"],
  "tests/namespace-projection-table.test.ts": ["70c7640c976b", "817c9f60b49f"],
  "tests/network-address.test.ts": ["3678d1748a15"],
  "tests/notification-command.ts": ["ce23058cd6de"],
  "tests/notification-lifetime-cases.ts": ["36b0199ebe1d"],
  "tests/operation-diagnostics-browser.ts": ["5bae43f4a551"],
  "tests/page-runner/asset-owner.test.ts": ["1443936ca613"],
  "tests/page-runner/bootstrap-diagnostics.test.ts": ["64b1919f2c29", "aae5bd2c26a0"],
  "tests/page-runner/browser-controls-runner.ts": ["410509dc6050", "99cc292d454f"],
  "tests/page-runner/collector.test.ts": ["b3a478f05430"],
  "tests/page-runner/command-controls.ts": ["5d12673c3bd8", "f8e9b35ae1dc", "fc316ad75d71"],
  "tests/page-runner/consumer-controls.ts": ["0a09b81edff1"],
  "tests/page-runner/framework-host.test.ts": ["5c543b9aec97", "7b5c52e9fff1"],
  "tests/page-runner/gpu-async-failure-controls.ts": ["23011ef03a69"],
  "tests/page-runner/host-drive-controls.ts": ["0d174378fb8f", "9495fcdd36ec", "d0642bfa274c"],
  "tests/page-runner/host-drive.test.ts": ["c499f8547683"],
  "tests/page-runner/host-storage-controls.ts": ["b64564651c59"],
  "tests/page-runner/peer-controls.ts": ["ea647484eecb"],
  "tests/page-runner/process-recycling-controls.ts": ["0a24fd3f2330", "388b53ad7e9d"],
  "tests/page-runner/publication-cross-tab-host.ts": ["45838293789e"],
  "tests/page-runner/reporter-control-failure.test.ts": ["33b77914a4c6"],
  "tests/page-runner/reporter-control-page.ts": ["4aa315f1cd94"],
  "tests/page-runner/safari-driver.test.ts": ["7cdb69c60d63"],
  "tests/page-runner/safari-observer.test.ts": ["163a8fd7b533"],
  "tests/page-runner/threads-runtime-suite.test.ts": ["c9b6ac9702e3"],
  "tests/page-runner/threads-runtime-suite.ts": ["af7e7096650e"],
  "tests/preview1-network-launch.test.ts": ["17ce7c0db173", "aa627902831a"],
  "tests/process-abi.test.ts": ["4770dc41aa49", "97e1c2734b6b", "a6714057ae84"],
  "tests/process-access.test.ts": ["be238fc1ecda"],
  "tests/process-admission.test.ts": ["903fc38382f6"],
  "tests/process-execve.test.ts": ["c264333b4b2a", "ec090a609412", "ec090a609412", "fc115c5dab8a"],
  "tests/process-navigation-observer.test.ts": ["62e171a180e0", "af49d5ff97ea"],
  "tests/process-quiescence.test.ts": ["7244cadbb52f"],
  "tests/process-root-navigation-diagnostic.ts": ["0b2546722d0b", "f047aaa5e516"],
  "tests/process-spawn-errno.test.ts": ["4948593519ca"],
  "tests/process-start-failed.test.ts": ["3662f48e4e90", "c668fd91ba7f"],
  "tests/process-worker-ownership.test.ts": ["6b5e8626ce8e", "cddf81946621"],
  "tests/sender-admission.test.ts": ["d21bf0ad2ecc"],
  "tests/start-failure-quiet-browser.ts": ["51ecddc1cfb8", "987ac12548fd"],
  "tests/storage-crash-r2-opfs.ts": ["1e5b84641114"],
  "tests/storage-lock-browser-runner.ts": ["36fc23e9f8a1", "a684c09dd2ab"],
  "tests/storage-lock-browser.ts": ["ed2365f524fb"],
  "tests/storage-quota-r2-probes.ts": ["0b8cd207c36e"],
  "tests/threads-fdstat.test.ts": ["e6a694803c30", "f0df68251995"],
  "tests/threads-lifecycle-module.ts": ["7357af474f03", "b7536c101cc9"],
  "tests/threads-runtime-browser.ts": ["409004cf34b7", "d8aeec0834a9"],
  "tests/threads-runtime-modules.ts": ["29fa77e03fab"],
  "tests/threads-runtime-safari-runner.ts": ["3ae8bdb234fc", "9f251cde7739"],
  "tests/threads-safari-runner.ts": ["6b06ef0f221b", "bb73cd9c54b4"],
  "tests/watch-root-runtime.test.ts": ["2091dd08ad44"],
  "tests/workspace-archive-pulls.test.ts": ["eca368ea93a6"],
  "tests/workspace-export.test.ts": ["daa68848d59f"],
  "tests/workspace-safari-runner.test.ts": ["04bd234c7be3", "31bb76b75136"],
  "tests/workspace-vfs-read-stream.test.ts": ["83638a54b846"],
  "tests/workspace-vfs-read.test.ts": [
    "2ccff3cbada7",
    "5a99ddcb3246",
    "d33de0f1e904",
    "d99de68779c9",
  ],
  "thread/guest-imports.ts": ["026bc25a060f", "d83e33dfad35", "d848e9fca793", "f23adc060ba7"],
  "thread/service.ts": [
    "2f0c1933281f",
    "2f1fd4e3d1e3",
    "b8d1d5af74cb",
    "cf000e8f7a73",
    "f15c5245e374",
  ],
  "tooling/gpu-measure.ts": ["6168d6f000d2", "97e3a7da628d", "c1a613306a6a"],
  "tooling/gpu-stream.ts": ["11ee57be6255", "43a45495892c", "4ec0458865a7", "d11d8d538b18"],
  "tooling/private-authority.ts": ["5469d705e413"],
  "tooling/vfs-benchmark.ts": ["fe7573432b07"],
  "tooling/vfs-score-config.ts": ["879025b549a3"],
  "tooling/vfs-score.ts": ["eb7f8c9f6567"],
  "tooling/vfs-workloads.ts": ["7b8fd6cd1be5", "f6de0403e483"],
  "tooling/workspace-safari-runner.ts": ["86f54e565e58", "fa21c0004ded"],
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

export function fingerprintExpression(source: string | Uint8Array): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 12);
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
      const fp = fingerprintExpression(source.subarray(span.offset, span.offset + span.length));
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
