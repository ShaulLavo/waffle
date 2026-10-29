import type { KnipConfig } from "knip";
import manifest from "./package.json";

// Package conditions, not directory globs, define the externally consumed API.
const publicSources = Array.from(
  new Set(Object.values(manifest.exports).map((entry) => entry.types.replace(/^\.\//, ""))),
);
const publicIssues = Object.fromEntries(
  publicSources.map((path) => [path, ["exports", "types"] as const]),
);

export default {
  includeEntryExports: true,
  ignoreIssues: publicIssues,
  tags: ["-@browserEntry", "-@compileFixture", "-@public"],
  workspaces: {
    ".": {
      entry: [
        "tests/**/*.test.ts",
        "tests/installer-symlinks-metadata-types.ts",
        "tests/fixtures/symlink-sizing-probe.ts",
        "tests/fixtures/interrupt-dom-consumer.ts",
        "scripts/browser-supervisor.ts",
        "tooling/check-network-rust.ts",
        "tests/{storage,storage-lock,process-recycling,network,notification,publication,publication-cross-tab,filesystem-transport,search-executor,search-program,guest-watch}-browser-runner.ts",
        "tests/search-executor-browser.ts",
        "tests/search-program-browser.ts",
        "search/{search,shard}-worker.ts",
        "tests/fixtures/search-fault-shard.ts",
        "tests/fixtures/search-count-worker.ts",
        "tests/fixtures/search-program-fs-worker.ts",
        "tests/filesystem-transport-browser{,-driver}.ts",
        "tests/fs-socket-browser-runner.ts",
        "tests/fixtures/filesystem-port-service.ts",
        "tests/interrupt-browser.ts",
        "tests/filesystem-{shutdown,ready-disposal}-browser-runner.ts",
        "tests/fixtures/filesystem-shutdown-{page,worker}.ts",
        "tests/fixtures/{browser-cell-clone,interrupt-browser-worker,preopen-node-host,startup-pool-worker}.ts",
        "tests/fixtures/opfs-close-{page,worker}.ts",
        "tests/opfs-range-browser-runner.ts",
        "tests/indexeddb-chunks-browser-runner.ts",
        "tests/indexeddb-chunks-browser.ts",
        "tests/workspace-vfs-read-browser.ts",
        "tests/fixtures/{diagnostic-public,start-failure-public}.ts",
        "tests/fixtures/private-authority-cases.ts",
        "tests/fixtures/preview-wire-headers-page.ts",
        "tests/persistent-authority-browser-runner.ts",
        "tests/owner-freeze-browser-runner.ts",
        "tests/workspace-continuity-browser-runner.ts",
        "tests/root-continuity-browser-runner.ts",
        "tests/fixtures/owner-freeze-{owner,guest}.ts",
        "tests/fixtures/persistent-authority-observer.ts",
        "tests/fixtures/publication-resident-{authority,guest}.ts",
        "tests/storage-lock-browser.ts",
        "tests/storage-lock-recovery-worker.ts",
        "tests/storage-open-worker.ts",
        "tests/memory-group-browser{,-runner}.ts",
        "tests/fixtures/memory-group-worker.ts",
      ],
      project: [
        "*.ts",
        "{browser,core,fs,group,proc,interrupt,search,scripts,tooling,tests}/**/*.{ts,js}",
      ],
    },
  },
} satisfies KnipConfig;
