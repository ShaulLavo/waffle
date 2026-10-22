import type { KnipConfig } from "knip";
import manifest from "./package.json";

// Package conditions, not directory globs, define the externally consumed API.
const publicSources = Array.from(
  new Set(Object.values(manifest.exports).map((entry) => entry.types.replace(/^\.\//, ""))),
);
const publicIssues = Object.fromEntries(
  publicSources
    .concat(["core/memory-views.d.ts"])
    .map((path) => [path, ["exports", "types"] as const]),
);

export default {
  includeEntryExports: true,
  ignoreIssues: publicIssues,
  tags: ["-@browserEntry", "-@compileFixture", "-@public"],
  workspaces: {
    ".": {
      entry: [
        "tests/**/*.test.ts",
        "scripts/browser-supervisor.ts",
        "tests/{storage,storage-lock,process-recycling,network,publication,publication-cross-tab}-browser-runner.ts",
        "tests/interrupt-browser.ts",
        "tests/filesystem-{shutdown,ready-disposal}-browser-runner.ts",
        "tests/fixtures/filesystem-shutdown-{page,worker}.ts",
        "tests/fixtures/{browser-cell-clone,interrupt-browser-worker,preopen-node-host}.ts",
        "tests/fixtures/opfs-close-{page,worker}.ts",
        "tests/opfs-range-browser-runner.ts",
        "tests/indexeddb-chunks-browser-runner.ts",
        "tests/indexeddb-chunks-browser.ts",
        "tests/fixtures/{diagnostic-public,start-failure-public}.ts",
        "tests/fixtures/private-authority-cases.ts",
        "tests/persistent-authority-browser-runner.ts",
        "tests/owner-freeze-browser-runner.ts",
        "tests/fixtures/owner-freeze-{owner,guest}.ts",
        "tests/fixtures/persistent-authority-observer.ts",
        "tests/fixtures/publication-resident-{authority,guest}.ts",
        "tests/storage-lock-browser.ts",
        "tests/storage-lock-recovery-worker.ts",
        "tests/storage-open-worker.ts",
      ],
      project: ["*.ts", "{browser,core,fs,proc,interrupt,scripts,tooling,tests}/**/*.{ts,js}"],
    },
    site: {
      entry: ["scripts/{extract-reference,performance,verify,visibility}.ts"],
      project: ["**/*.{ts,astro}"],
    },
  },
} satisfies KnipConfig;
