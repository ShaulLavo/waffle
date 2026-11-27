import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Pre-existing legacy nested-ternary violation counts per file.
 * Baseline only shrinks: adding a nested ternary to a listed file fails lint, and
 * reducing violations requires lowering the count (or removing the file at 0 from
 * both this map and .oxlintrc.json overrides). */
export const LEGACY_NESTED_TERNARY_COUNTS: Readonly<Record<string, number>> = {
  "browser/display/owner.ts": 1,
  "browser/gpu/codec.ts": 3,
  "browser/gpu/guest.ts": 1,
  "browser/gpu/metadata.ts": 2,
  "browser/gpu/replay.ts": 3,
  "browser/gpu/service.ts": 1,
  "browser/guarded-stream.ts": 1,
  "browser/net/helper.ts": 1,
  "browser/net/namespace.ts": 1,
  "browser/operations/guest.ts": 1,
  "browser/operations/owner.ts": 1,
  "browser/operations/writer.ts": 1,
  "browser/preview1-socket.ts": 1,
  "browser/process-broker.ts": 8,
  "browser/terminal-session.ts": 2,
  "browser/worker.ts": 6,
  "core/wasi.ts": 16,
  "fs/backend.ts": 2,
  "fs/client.ts": 2,
  "fs/directory-pages.ts": 2,
  "fs/identity-allocation.ts": 1,
  "fs/idle-owner.ts": 1,
  "fs/indexeddb.ts": 2,
  "fs/memory.ts": 2,
  "fs/multitab-backend.ts": 1,
  "fs/namespace-projection-table.ts": 9,
  "fs/opfs.ts": 2,
  "fs/persistent.ts": 4,
  "fs/publication-attachment.ts": 1,
  "fs/request-memory.ts": 3,
  "fs/service.ts": 4,
  "fs/shared.ts": 4,
  "fs/watch-ring.ts": 1,
  "fs/watch-service.ts": 2,
  "fs/workspace-archive.ts": 3,
  "fs/workspace.ts": 2,
  "group/member.ts": 1,
  "interrupt/wait.ts": 1,
  "memory/declarations.ts": 1,
  "proc/abi.ts": 3,
  "proc/access.ts": 4,
  "proc/command-stdio.ts": 2,
  "proc/directory.ts": 1,
  "proc/node-wasi.ts": 4,
  "proc/observation.ts": 1,
  "proc/outcome.ts": 2,
  "proc/registry.ts": 3,
  "proc/signals.ts": 1,
  "proc/start-diagnostic.ts": 1,
  "proc/start-failure.ts": 3,
  "proc/supervisor.ts": 1,
  "proc/wait-status.ts": 1,
  "proc/worker-broker.ts": 2,
  "proc/worker-pipes.ts": 1,
  "search/engine.ts": 1,
  "testing/indexeddb-storage-browser.ts": 1,
  "testing/page-runner/bootstrap-diagnostics.ts": 1,
  "testing/page-runner/browser-observation.ts": 2,
  "testing/page-runner/framework-queue.ts": 2,
  "testing/page-runner/framework-trace.ts": 3,
  "testing/page-runner/host-drive.ts": 1,
  "testing/page-runner/inspector-plist.ts": 1,
  "testing/page-runner/safari-driver.ts": 2,
  "testing/page-runner/suite-host.ts": 6,
  "testing/storage-navigation-diagnostics.ts": 1,
  "tests/browser-matrix.test.ts": 4,
  "tests/browser-worker.test.ts": 2,
  "tests/c-threads-safari-runner.ts": 2,
  "tests/filesystem-retired-release.test.ts": 1,
  "tests/filesystem-shutdown-close-observation.test.ts": 1,
  "tests/filesystem-shutdown.test.ts": 1,
  "tests/fixtures/default-allocation-capture.ts": 1,
  "tests/fixtures/descendant-real-worker.ts": 2,
  "tests/fixtures/gpu/async-host.ts": 1,
  "tests/fixtures/gpu/async-native.ts": 1,
  "tests/fixtures/gpu/bundle-query-native.ts": 1,
  "tests/fixtures/gpu/compute-native.ts": 1,
  "tests/fixtures/gpu/copy-draw-native.ts": 4,
  "tests/fixtures/gpu/integration-guest.ts": 1,
  "tests/fixtures/gpu/integration-service-worker.ts": 2,
  "tests/fixtures/gpu/ownership-service-worker.ts": 4,
  "tests/fixtures/gpu/ring-worker.ts": 1,
  "tests/fixtures/gpu/scene-native.ts": 1,
  "tests/fixtures/interrupt-symbols-worker.ts": 1,
  "tests/fixtures/nested-wasi.ts": 1,
  "tests/fixtures/search-count-worker.ts": 1,
  "tests/fixtures/shared-caller-exec.ts": 2,
  "tests/fixtures/vfs-backends.ts": 1,
  "tests/fixtures/vfs-fd-conformance-worker.ts": 2,
  "tests/gpu-admission-browser.ts": 1,
  "tests/gpu-admission-controls.test.ts": 4,
  "tests/gpu-async-command.test.ts": 2,
  "tests/gpu-async-command.ts": 1,
  "tests/gpu-async-fixture.test.ts": 1,
  "tests/gpu-async-payload.test.ts": 1,
  "tests/gpu-browser-shared.ts": 1,
  "tests/gpu-ci.test.ts": 2,
  "tests/gpu-copy-draw-replay.test.ts": 1,
  "tests/gpu-desktop-measure.test.ts": 1,
  "tests/gpu-disposal-controls.test.ts": 2,
  "tests/gpu-grant-quota-browser.ts": 1,
  "tests/gpu-grant-quota-controls.test.ts": 2,
  "tests/gpu-malformed-browser.ts": 3,
  "tests/gpu-malformed-controls.test.ts": 3,
  "tests/gpu-native-controls.test.ts": 1,
  "tests/gpu-ownership-controls.test.ts": 1,
  "tests/gpu-payload-pressure-browser.ts": 4,
  "tests/gpu-payload-pressure-controls.test.ts": 8,
  "tests/gpu-regrant-controls.test.ts": 5,
  "tests/gpu-replay.test.ts": 1,
  "tests/gpu-service-failure-browser.ts": 1,
  "tests/gpu-service-failure-controls.test.ts": 1,
  "tests/indexeddb-chunks-browser.ts": 1,
  "tests/indexeddb-chunks.test.ts": 1,
  "tests/installer-symlinks-borrow.test.ts": 1,
  "tests/installer-symlinks-readlink.test.ts": 1,
  "tests/interrupt-wait-profile.test.ts": 1,
  "tests/link-program.test.ts": 1,
  "tests/memory-budget.test.ts": 1,
  "tests/namespace-projection-table.test.ts": 2,
  "tests/network-address.test.ts": 1,
  "tests/notification-command.ts": 1,
  "tests/notification-lifetime-cases.ts": 1,
  "tests/operation-diagnostics-browser.ts": 1,
  "tests/page-runner/asset-owner.test.ts": 1,
  "tests/page-runner/bootstrap-diagnostics.test.ts": 2,
  "tests/page-runner/browser-controls-runner.ts": 2,
  "tests/page-runner/collector.test.ts": 1,
  "tests/page-runner/command-controls.ts": 3,
  "tests/page-runner/consumer-controls.ts": 1,
  "tests/page-runner/framework-host.test.ts": 2,
  "tests/page-runner/gpu-async-failure-controls.ts": 1,
  "tests/page-runner/host-drive-controls.ts": 3,
  "tests/page-runner/host-drive.test.ts": 1,
  "tests/page-runner/host-storage-controls.ts": 1,
  "tests/page-runner/peer-controls.ts": 1,
  "tests/page-runner/process-recycling-controls.ts": 2,
  "tests/page-runner/publication-cross-tab-host.ts": 1,
  "tests/page-runner/reporter-control-failure.test.ts": 1,
  "tests/page-runner/reporter-control-page.ts": 1,
  "tests/page-runner/safari-driver.test.ts": 1,
  "tests/page-runner/safari-observer.test.ts": 1,
  "tests/page-runner/threads-runtime-suite.test.ts": 1,
  "tests/page-runner/threads-runtime-suite.ts": 1,
  "tests/preview1-network-launch.test.ts": 2,
  "tests/process-abi.test.ts": 3,
  "tests/process-access.test.ts": 1,
  "tests/process-admission.test.ts": 1,
  "tests/process-execve.test.ts": 4,
  "tests/process-navigation-observer.test.ts": 2,
  "tests/process-quiescence.test.ts": 1,
  "tests/process-root-navigation-diagnostic.ts": 2,
  "tests/process-spawn-errno.test.ts": 1,
  "tests/process-start-failed.test.ts": 2,
  "tests/process-worker-ownership.test.ts": 2,
  "tests/search-program-browser-runner.ts": 3,
  "tests/sender-admission.test.ts": 1,
  "tests/start-failure-quiet-browser.ts": 2,
  "tests/storage-crash-r2-opfs.ts": 1,
  "tests/storage-lock-browser-runner.ts": 2,
  "tests/storage-lock-browser.ts": 1,
  "tests/storage-quota-r2-probes.ts": 1,
  "tests/threads-fdstat.test.ts": 2,
  "tests/threads-lifecycle-module.ts": 2,
  "tests/threads-runtime-browser.ts": 2,
  "tests/threads-runtime-modules.ts": 1,
  "tests/threads-runtime-safari-runner.ts": 2,
  "tests/threads-safari-runner.ts": 2,
  "tests/watch-root-runtime.test.ts": 1,
  "tests/workspace-archive-pulls.test.ts": 1,
  "tests/workspace-export.test.ts": 1,
  "tests/workspace-safari-runner.test.ts": 2,
  "tests/workspace-vfs-read-stream.test.ts": 1,
  "tests/workspace-vfs-read.test.ts": 4,
  "thread/guest-imports.ts": 4,
  "thread/service.ts": 5,
  "tooling/gpu-measure.ts": 3,
  "tooling/gpu-stream.ts": 4,
  "tooling/private-authority.ts": 1,
  "tooling/vfs-benchmark.ts": 1,
  "tooling/vfs-score-config.ts": 1,
  "tooling/vfs-score.ts": 1,
  "tooling/vfs-workloads.ts": 2,
  "tooling/workspace-safari-runner.ts": 2,
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
  counts: Readonly<Record<string, number>>,
): string[] {
  const errors: string[] = [];
  const overrideSet = new Set(overrideFiles);
  for (const file of overrideFiles) {
    const count = counts[file];
    if (count === undefined || !Number.isInteger(count) || count < 1) {
      errors.push(
        `.oxlintrc.json override ${file} has no positive count in LEGACY_NESTED_TERNARY_COUNTS`,
      );
    }
  }
  for (const [file, count] of Object.entries(counts)) {
    if (!Number.isInteger(count) || count < 1) {
      errors.push(`invalid baseline count for ${file}: ${count}`);
    }
    if (!overrideSet.has(file)) {
      errors.push(`baseline entry ${file} is missing from .oxlintrc.json overrides`);
    }
  }
  return errors;
}

function countActualViolations(
  root: string,
  files: readonly string[],
  oxlintBin: string,
): { counts: Map<string, number>; error?: string } {
  const counts = new Map<string, number>();
  if (files.length === 0) return { counts };
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
        counts,
        error: `oxlint failed without JSON output: ${proc.stderr.toString().trim()}`,
      };
    }
    const parsed = JSON.parse(stdout) as { diagnostics?: OxlintDiagnostic[] };
    for (const diagnostic of parsed.diagnostics ?? []) {
      if (diagnostic.code !== "eslint(no-nested-ternary)" || !diagnostic.filename) continue;
      const normalized = diagnostic.filename.replaceAll("\\", "/");
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
    return { counts };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function checkNestedTernaryBaseline(
  root: string,
  counts: Readonly<Record<string, number>> = LEGACY_NESTED_TERNARY_COUNTS,
  oxlintBin = join(root, "node_modules/.bin/oxlint"),
): string[] {
  const { files, errors } = readOverrideFiles(root);
  const alignment = validateBaselineAlignment(files, counts);
  if (errors.length > 0 || alignment.length > 0) return errors.concat(alignment);

  const missing = files.filter((file) => !existsSync(join(root, file)));
  if (missing.length > 0) {
    return missing.map(
      (file) =>
        `deleted legacy file ${file} is still listed — remove from LEGACY_NESTED_TERNARY_COUNTS and .oxlintrc.json overrides`,
    );
  }

  const actual = countActualViolations(root, files, oxlintBin);
  if (actual.error) return [actual.error];

  const findings: string[] = [];
  for (const file of files) {
    const expected = counts[file]!;
    const found = actual.counts.get(file) ?? 0;
    if (found > expected) {
      findings.push(
        `new nested ternary violation(s) in legacy file ${file} (expected ${expected}, found ${found}) — refactor instead of adding nested ternaries`,
      );
    } else if (found < expected) {
      const suffix = found === 0 ? " and remove from .oxlintrc.json overrides" : "";
      findings.push(
        `legacy baseline for ${file} can shrink (expected ${expected}, found ${found}) — update LEGACY_NESTED_TERNARY_COUNTS${suffix}`,
      );
    }
  }
  return findings;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const findings = checkNestedTernaryBaseline(root);
  if (findings.length > 0) {
    for (const finding of findings) console.error(finding);
    process.exit(1);
  }
}
