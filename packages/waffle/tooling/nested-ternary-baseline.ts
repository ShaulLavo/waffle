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
  "browser/display/owner.ts": ["ab4a8a214bd0"],
  "browser/gpu/codec.ts": ["3bd64f744394", "6a7c25e8718a", "bc32706d9322"],
  "browser/gpu/guest.ts": ["65849a9b1a3d"],
  "browser/gpu/metadata.ts": ["3bd64f744394", "bc32706d9322"],
  "browser/gpu/replay.ts": ["4fb376bd0851", "b11dd6202124", "b72b596d185a"],
  "browser/gpu/service.ts": ["9dcbecf9774e"],
  "browser/guarded-stream.ts": ["c853f6587737"],
  "browser/net/helper.ts": ["eec8bab43115"],
  "browser/net/namespace.ts": ["0bb2987e34db"],
  "browser/operations/guest.ts": ["c3c6552caff5"],
  "browser/operations/owner.ts": ["5abd5d5878a7"],
  "browser/operations/writer.ts": ["f26334647139"],
  "browser/preview1-socket.ts": ["3b96ab8df37d"],
  "browser/process-broker.ts": [
    "46703ec95cce",
    "6a929ad93f48",
    "aef649ea9fd0",
    "c05b1db91d1e",
    "deb7861d5218",
    "ef1e2f9ed35e",
    "ef43f8cfecb3",
    "f60c078d5fc5",
  ],
  "browser/terminal-session.ts": ["6ed0c9225ac8", "904eb3fcd552"],
  "browser/worker.ts": [
    "05724a93e2c0",
    "27db76e1c7fd",
    "7a4982de5ebb",
    "bb4e546b2be2",
    "cffe32d20fcd",
    "f9cca3f6962f",
  ],
  "core/wasi.ts": [
    "4663c97a5f87",
    "5329cee51d47",
    "568dd2bee862",
    "5fc770487e15",
    "609e279a5fd6",
    "65272f1d236c",
    "70148179c619",
    "854c2420f9ac",
    "af9947c0e464",
    "b738b13f6678",
    "c109c2d3b085",
    "ca2c3a953900",
    "d2abd477fe94",
    "d63c5128651c",
    "e1bff00f3102",
    "fe7462a9611a",
  ],
  "fs/backend.ts": ["580e1380ca39", "f8484dfcce6a"],
  "fs/client.ts": ["54b2b669cb5d", "6e1154e6c67f"],
  "fs/directory-pages.ts": ["585589a65342", "ba61368c9638"],
  "fs/identity-allocation.ts": ["abfaa776ef95"],
  "fs/idle-owner.ts": ["3f765004cccf"],
  "fs/indexeddb.ts": ["0aa991542059", "f87558bf8455"],
  "fs/memory.ts": ["5e4c7c9a9b55", "5e4c7c9a9b55"],
  "fs/multitab-backend.ts": ["67af7fcfcab8"],
  "fs/namespace-projection-table.ts": [
    "0c78203b4e57",
    "3ea328cd7d1e",
    "4302c144e5dd",
    "625d0c10e23d",
    "6af113e230e3",
    "d0ec0d048019",
    "d0ec0d048019",
    "d3f7ac053a6a",
    "f0325bd39c6d",
  ],
  "fs/opfs.ts": ["82c418c62a43", "abca47650a67"],
  "fs/persistent.ts": ["0797e746fa9c", "77ec706c11e6", "c378c3c706e8", "c634621ea6c7"],
  "fs/publication-attachment.ts": ["af44948c07a6"],
  "fs/request-memory.ts": ["0a46e82554ed", "25cb983863dd", "59afca38670c"],
  "fs/service.ts": ["89091af3888f", "ab8c38e5a46f", "b052767c3168", "ee0c8be957c2"],
  "fs/shared.ts": ["a66b222226d1", "b790ffaa3bce", "dc714ab37485", "df8b87ad6a34"],
  "fs/watch-ring.ts": ["c5b2f07db3ee"],
  "fs/watch-service.ts": ["377a8ff7b240", "b57e3e6ea37a"],
  "fs/workspace-archive.ts": ["0ef8f043eedf", "602f3178ed22", "ec34b085e5a8"],
  "fs/workspace.ts": ["33a27174e9a7", "703bbe9d4c41"],
  "group/member.ts": ["e19dae469c01"],
  "interrupt/wait.ts": ["09c7d33f72a6"],
  "memory/declarations.ts": ["7d5a3924ecc9"],
  "proc/abi.ts": ["4da3eaf99b09", "a4c9670b0376", "df25a004fd39"],
  "proc/access.ts": ["074c0b520043", "231b85a5f863", "29f95a3f9cc3", "6f07ebc37713"],
  "proc/command-stdio.ts": ["3617999ff49e", "7d6279a9ff98"],
  "proc/directory.ts": ["5a7fef5c3ffa"],
  "proc/node-wasi.ts": ["0a78b2af92ac", "4ba3a8a81867", "9ba07f147e99", "a0af1d3d1328"],
  "proc/observation.ts": ["5840a29a354c"],
  "proc/outcome.ts": ["5840a29a354c", "e29c00d88bc6"],
  "proc/registry.ts": ["337bceaf0803", "7e73f1671b49", "8d518367f8ca"],
  "proc/signals.ts": ["fe624cb2000b"],
  "proc/start-diagnostic.ts": ["6dceff007bd4"],
  "proc/start-failure.ts": ["3de7cc7049a2", "91eee16cdad9", "992feddb718b"],
  "proc/supervisor.ts": ["7f636ef3b018"],
  "proc/wait-status.ts": ["2c7fc3986172"],
  "proc/worker-broker.ts": ["361ddbfb05d9", "5cc697f1a89d"],
  "proc/worker-pipes.ts": ["a26a766ae85e"],
  "search/engine.ts": ["077277c4f96b"],
  "testing/indexeddb-storage-browser.ts": ["cd57345692d6"],
  "testing/page-runner/bootstrap-diagnostics.ts": ["86d70aa92cb8"],
  "testing/page-runner/browser-observation.ts": ["18e525f23ae1", "29f217ada42b"],
  "testing/page-runner/framework-queue.ts": ["4a45a2bbd357", "e86f4654cb05"],
  "testing/page-runner/framework-trace.ts": ["406c7c8549df", "69c38d3994d0", "a24d3d78e753"],
  "testing/page-runner/host-drive.ts": ["8c0e7810a940"],
  "testing/page-runner/inspector-plist.ts": ["f513f2a61955"],
  "testing/page-runner/safari-driver.ts": ["c150f2039974", "ff864dc785d4"],
  "testing/page-runner/suite-host.ts": [
    "082897115095",
    "3e98accfdd2e",
    "48783f0cecf0",
    "56416142bcc6",
    "f45bfe72b390",
    "fc9073e9ebc3",
  ],
  "testing/storage-navigation-diagnostics.ts": ["e35844cc58bb"],
  "tests/browser-matrix.test.ts": ["24d757bbc13b", "261a1d58c1ad", "3cf3ef40fc0c", "4ed95b36dfa7"],
  "tests/browser-worker.test.ts": ["5d1465c30653", "5d1465c30653"],
  "tests/c-threads-safari-runner.ts": ["aeaa050a66b6", "b49049bc5c51"],
  "tests/filesystem-retired-release.test.ts": ["691f97de542f"],
  "tests/filesystem-shutdown-close-observation.test.ts": ["e5f53bb97503"],
  "tests/filesystem-shutdown.test.ts": ["f4e20a227139"],
  "tests/fixtures/default-allocation-capture.ts": ["0a07be2eea26"],
  "tests/fixtures/descendant-real-worker.ts": ["54e370565824", "c1e77b7b3105"],
  "tests/fixtures/gpu/async-host.ts": ["3258532ed775"],
  "tests/fixtures/gpu/async-native.ts": ["5f5ad62cba04"],
  "tests/fixtures/gpu/bundle-query-native.ts": ["1e55a1c410ae"],
  "tests/fixtures/gpu/compute-native.ts": ["6d50dc795a58"],
  "tests/fixtures/gpu/copy-draw-native.ts": [
    "637ab05893f8",
    "914ca13b5195",
    "a5a0507e4a90",
    "c7c94b8c59b6",
  ],
  "tests/fixtures/gpu/integration-guest.ts": ["4c0dd419ca28"],
  "tests/fixtures/gpu/integration-service-worker.ts": ["8c6a498d9578", "e956a8cb88e4"],
  "tests/fixtures/gpu/ownership-service-worker.ts": [
    "09210de30440",
    "b71a9ef41a0f",
    "d3113b9c2e83",
    "db9447bd02de",
  ],
  "tests/fixtures/gpu/ring-worker.ts": ["63f26024d452"],
  "tests/fixtures/gpu/scene-native.ts": ["29d117405bf3"],
  "tests/fixtures/interrupt-symbols-worker.ts": ["6b7429c2dc65"],
  "tests/fixtures/nested-wasi.ts": ["1e34523230ea"],
  "tests/fixtures/search-count-worker.ts": ["084ec38cb1c0"],
  "tests/fixtures/shared-caller-exec.ts": ["0958835bb2fb", "d19b181b1ea8"],
  "tests/fixtures/vfs-backends.ts": ["e849794fcc48"],
  "tests/fixtures/vfs-fd-conformance-worker.ts": ["06ca3710f627", "1500cbe2de77"],
  "tests/gpu-admission-browser.ts": ["33bfaf1f3b96"],
  "tests/gpu-admission-controls.test.ts": [
    "00a82def53c0",
    "a7e2e4e3b258",
    "a8db8013161c",
    "d76219f59f9e",
  ],
  "tests/gpu-async-command.test.ts": ["312994bc19cd", "8543e3aecc0c"],
  "tests/gpu-async-command.ts": ["9801caaf5a6f"],
  "tests/gpu-async-fixture.test.ts": ["8f835ec4876d"],
  "tests/gpu-async-payload.test.ts": ["e81b3f3c09b3"],
  "tests/gpu-browser-shared.ts": ["1746c6fed546"],
  "tests/gpu-ci.test.ts": ["1b109e435ba7", "db9e05055a95"],
  "tests/gpu-copy-draw-replay.test.ts": ["a1a36bfb3544"],
  "tests/gpu-desktop-measure.test.ts": ["977da724f0b6"],
  "tests/gpu-disposal-controls.test.ts": ["5bf163d50829", "fcfd35af21b7"],
  "tests/gpu-grant-quota-browser.ts": ["97fbbe9ddda7"],
  "tests/gpu-grant-quota-controls.test.ts": ["1628e51d58c0", "50ef764c466c"],
  "tests/gpu-malformed-browser.ts": ["15c750849f79", "b4cded221478", "d3113b9c2e83"],
  "tests/gpu-malformed-controls.test.ts": ["25b223849bcd", "9a9a7f21ef4f", "9acddb6ff978"],
  "tests/gpu-native-controls.test.ts": ["27bc2904da55"],
  "tests/gpu-ownership-controls.test.ts": ["9d1865f907e3"],
  "tests/gpu-payload-pressure-browser.ts": [
    "3f2ed3433553",
    "42daf8715f57",
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
  "tests/gpu-replay.test.ts": ["d4d808516125"],
  "tests/gpu-service-failure-browser.ts": ["fb948a842c7d"],
  "tests/gpu-service-failure-controls.test.ts": ["580398a08b19"],
  "tests/indexeddb-chunks-browser.ts": ["d4bb29a30d3d"],
  "tests/indexeddb-chunks.test.ts": ["b0fd6ae3cc6b"],
  "tests/installer-symlinks-borrow.test.ts": ["6b6a4372d8b5"],
  "tests/installer-symlinks-readlink.test.ts": ["a042cc220e3a"],
  "tests/interrupt-wait-profile.test.ts": ["841f8d3c5f29"],
  "tests/link-program.test.ts": ["202ced5d666c"],
  "tests/memory-budget.test.ts": ["3211e66449d2"],
  "tests/namespace-projection-table.test.ts": ["a55b39fbe553", "d351b0878bfd"],
  "tests/network-address.test.ts": ["3678d1748a15"],
  "tests/notification-command.ts": ["a915ddad1572"],
  "tests/notification-lifetime-cases.ts": ["36b0199ebe1d"],
  "tests/operation-diagnostics-browser.ts": ["8295f60d5c7c"],
  "tests/page-runner/asset-owner.test.ts": ["f80137b67472"],
  "tests/page-runner/bootstrap-diagnostics.test.ts": ["b8f7e9527641", "c4077a5add03"],
  "tests/page-runner/browser-controls-runner.ts": ["7378accadcb4", "cafeffc8c137"],
  "tests/page-runner/collector.test.ts": ["6799a36f1ca2"],
  "tests/page-runner/command-controls.ts": ["5d12673c3bd8", "f8e9b35ae1dc", "fc316ad75d71"],
  "tests/page-runner/consumer-controls.ts": ["77c451606941"],
  "tests/page-runner/framework-host.test.ts": ["04ae8f3a12d2", "04ae8f3a12d2"],
  "tests/page-runner/gpu-async-failure-controls.ts": ["e9980b87dcb7"],
  "tests/page-runner/host-drive-controls.ts": ["33051ea2f6b5", "557bb046730a", "b8066928b181"],
  "tests/page-runner/host-drive.test.ts": ["f5e1d1347216"],
  "tests/page-runner/host-storage-controls.ts": ["b64564651c59"],
  "tests/page-runner/peer-controls.ts": ["ea647484eecb"],
  "tests/page-runner/process-recycling-controls.ts": ["7879159a01cf", "cf77feb829b3"],
  "tests/page-runner/publication-cross-tab-host.ts": ["f898e78b6058"],
  "tests/page-runner/reporter-control-failure.test.ts": ["33b77914a4c6"],
  "tests/page-runner/reporter-control-page.ts": ["04fbaa585a5e"],
  "tests/page-runner/safari-driver.test.ts": ["5889677dc697"],
  "tests/page-runner/safari-observer.test.ts": ["163a8fd7b533"],
  "tests/page-runner/threads-runtime-suite.test.ts": ["561109469906"],
  "tests/page-runner/threads-runtime-suite.ts": ["561109469906"],
  "tests/preview1-network-launch.test.ts": ["22744dd51c9f", "9efbcd39c8cb"],
  "tests/process-abi.test.ts": ["a1af90f54c09", "c41058be6489", "e3497c8e5982"],
  "tests/process-access.test.ts": ["43eabba76481"],
  "tests/process-admission.test.ts": ["742be413858a"],
  "tests/process-execve.test.ts": ["c264333b4b2a", "ec090a609412", "ec090a609412", "fc115c5dab8a"],
  "tests/process-navigation-observer.test.ts": ["62e171a180e0", "af49d5ff97ea"],
  "tests/process-quiescence.test.ts": ["7244cadbb52f"],
  "tests/process-root-navigation-diagnostic.ts": ["0e82dd56695c", "480bad4dd536"],
  "tests/process-spawn-errno.test.ts": ["2c89ea5536fa"],
  "tests/process-start-failed.test.ts": ["142c0fec3e3c", "6c21abe6949e"],
  "tests/process-worker-ownership.test.ts": ["6b5e8626ce8e", "fe7f1c3e5d56"],
  "tests/search-program-browser-runner.ts": ["11702227dc8a", "251d751e5de3", "538e972e568b"],
  "tests/sender-admission.test.ts": ["d21bf0ad2ecc"],
  "tests/start-failure-quiet-browser.ts": ["51ecddc1cfb8", "e2a35224309e"],
  "tests/storage-crash-r2-opfs.ts": ["efdfe789675c"],
  "tests/storage-lock-browser-runner.ts": ["36fc23e9f8a1", "a684c09dd2ab"],
  "tests/storage-lock-browser.ts": ["339867edffad"],
  "tests/storage-quota-r2-probes.ts": ["0b8cd207c36e"],
  "tests/threads-fdstat.test.ts": ["aa91882582ad", "f0df68251995"],
  "tests/threads-lifecycle-module.ts": ["119685d8bdb0", "39147d9b2a4f"],
  "tests/threads-runtime-browser.ts": ["409004cf34b7", "820edb2fd8bb"],
  "tests/threads-runtime-modules.ts": ["f1f091ccd7b6"],
  "tests/threads-runtime-safari-runner.ts": ["a4e425237e10", "b49049bc5c51"],
  "tests/threads-safari-runner.ts": ["77b70c2656ca", "b49049bc5c51"],
  "tests/watch-root-runtime.test.ts": ["2091dd08ad44"],
  "tests/workspace-archive-pulls.test.ts": ["56b1aa61401b"],
  "tests/workspace-export.test.ts": ["269a7068141b"],
  "tests/workspace-safari-runner.test.ts": ["c1d778b46f9d", "e61b00548da5"],
  "tests/workspace-vfs-read-stream.test.ts": ["d85b9ae62b4b"],
  "tests/workspace-vfs-read.test.ts": [
    "aa06507e3a39",
    "c5d11b5709ed",
    "c962793002ce",
    "e04211c5b0bc",
  ],
  "thread/guest-imports.ts": ["026bc25a060f", "d83e33dfad35", "d848e9fca793", "f23adc060ba7"],
  "thread/service.ts": [
    "2abaf95eb9c6",
    "8940c870aca4",
    "cce9f662a04e",
    "ce763fc31d03",
    "fb39ab52235a",
  ],
  "tooling/gpu-measure.ts": ["6168d6f000d2", "c1a613306a6a", "ca8c69e675f4"],
  "tooling/gpu-stream.ts": ["0a02f66e5b82", "a7e904e2b78d", "a83c9878b55c", "ebffad6b9a29"],
  "tooling/private-authority.ts": ["f29a34e783ea"],
  "tooling/vfs-benchmark.ts": ["2c3c4a0b03ec"],
  "tooling/vfs-score-config.ts": ["a2cbd62450e1"],
  "tooling/vfs-score.ts": ["6b50bf32d250"],
  "tooling/vfs-workloads.ts": ["91ad6c770d65", "c74aef2544c4"],
  "tooling/workspace-safari-runner.ts": ["bac54203f937", "f3afa35f0f91"],
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

export function fingerprintExpression(source: string): string {
  const normalized = source.replace(/\s+/g, " ").trim();
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

function loadBaseBaseline(root: string, baseRef: string): NestedTernaryBaseline | undefined {
  const proc = Bun.spawnSync(
    ["git", "show", `origin/${baseRef}:packages/waffle/tooling/nested-ternary-baseline.ts`],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) return undefined;
  const text = proc.stdout.toString();
  const match =
    /LEGACY_NESTED_TERNARY_BASELINE:\s*NestedTernaryBaseline\s*=\s*(\{[\s\S]*?\n\});/.exec(text);
  if (!match) return undefined;
  return Bun.JSONC.parse(match[1]!.replace(/,\s*([}\]])/g, "$1")) as NestedTernaryBaseline;
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
    const sourceCache = new Map<string, string>();
    for (const diagnostic of parsed.diagnostics ?? []) {
      if (diagnostic.code !== "eslint(no-nested-ternary)" || !diagnostic.filename) continue;
      const normalized = diagnostic.filename.replaceAll("\\", "/");
      const span = diagnostic.labels?.[0]?.span;
      if (!span) continue;
      let source = sourceCache.get(normalized);
      if (source === undefined) {
        source = readFileSync(join(root, normalized), "utf8");
        sourceCache.set(normalized, source);
      }
      const fp = fingerprintExpression(source.slice(span.offset, span.offset + span.length));
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
    if (previous)
      findings.push(...checkBaselineMonotonic(previous, LEGACY_NESTED_TERNARY_BASELINE));
  }
  if (findings.length > 0) {
    for (const finding of findings) console.error(finding);
    process.exit(1);
  }
}
