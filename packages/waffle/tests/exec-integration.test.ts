import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { runExecIntegration, type ExecIntegrationMode } from "./fixtures/exec-integration.js";
import { installExecNodeWorkers } from "./fixtures/exec-node-host.js";

const modes: ExecIntegrationMode[] = [
  "replace",
  "start-section-failure",
  "adapter-setup-failure",
  "runtime-trap",
  "twice",
  "preopen-remap",
  "omit-preopen",
  "capacity-control",
  "capacity-exec",
];
const expectedCode = (mode: ExecIntegrationMode) =>
  mode.endsWith("-failure") || mode === "runtime-trap" ? 126 : 0;
for (const mode of modes)
  test(`source consumer exec ${mode} uses real Workers`, async () => {
    const restore = installExecNodeWorkers();
    try {
      const report = await runExecIntegration({
        mode,
        workerUrl: new URL("./fixtures/exec-node-worker.ts", import.meta.url).href,
      });
      console.log(JSON.stringify({ execIntegration: report }));
      expect(report.result).toMatchObject({ kind: "exited", code: expectedCode(mode) });
    } finally {
      restore();
    }
  }, 20000);

test("prepared Node consumers execute the same replacement and capacity controls", async () => {
  const scratch = await mkdtemp("/work/tmp/waffle-exec-node-");
  const root = resolve(import.meta.dir, "..");
  try {
    const build = await Bun.build({
      entrypoints: [
        join(import.meta.dir, "fixtures/exec-node-control.ts"),
        join(import.meta.dir, "fixtures/exec-node-worker.ts"),
      ],
      outdir: scratch,
      naming: "[name].mjs",
      target: "node",
      format: "esm",
      plugins: [
        {
          name: "prepared-waffle-imports",
          setup(builder) {
            builder.onResolve(
              { filter: /^\.\.\/\.\.\/(browser|core|fs|memory|proc|link|interrupt)\// },
              (args) => ({
                path: join(
                  root,
                  "dist",
                  relative(root, resolve(args.resolveDir, args.path)).replace(/\.ts$/, ".js"),
                ),
                external: true,
              }),
            );
          },
        },
      ],
    });
    if (!build.success) throw new AggregateError(build.logs, "prepared exec fixture build failed");
    for (const mode of modes) {
      const result = spawnSync(
        "node",
        [
          join(scratch, "exec-node-control.mjs"),
          mode,
          pathToFileURL(join(scratch, "exec-node-worker.mjs")).href,
        ],
        { encoding: "utf8", timeout: 20000 },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      console.log(result.stdout.trim());
      expect(JSON.parse(result.stdout).result).toMatchObject({
        kind: "exited",
        code: expectedCode(mode),
      });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 90000);
