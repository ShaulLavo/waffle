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
        "tests/interrupt-browser.ts",
        "tests/fixtures/{browser-cell-clone,interrupt-browser-worker,preopen-node-host}.ts",
        "tests/fixtures/{diagnostic-public,start-failure-public}.ts",
        "tests/fixtures/private-authority-cases.ts",
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
