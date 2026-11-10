import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPageSuite } from "waffle/testing/page-runner";
import { PlaywrightDriver } from "waffle/testing/page-runner/playwright";
import {
  filesystemTransportAdapter,
  filesystemTransportId as id,
} from "./filesystem-transport-suite.js";

const browserTest = process.env.FS_TRANSPORT_BROWSER_CONTROLS === "1" ? test : test.skip;
for (const failChild of [false, true]) {
  browserTest(
    `complete original command through HostCase, child failure ${failChild}`,
    async () => {
      const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "wft-b-"));
      const scratch = join(root, "s");
      let driver: PlaywrightDriver | undefined;
      try {
        // Only the failure control is shortened. Acceptance always runs the stock 60 rounds.
        const adapter = filesystemTransportAdapter(failChild ? 1 : 60);
        const assets = await adapter.assets({
          scratch: root,
          signal: new AbortController().signal,
        });
        if (failChild) {
          const child = assets["/child.js"];
          if (!child || typeof child === "string") throw new Error("Missing actual child producer");
          const source = await child.text();
          expect(source.split("output.length === bytes")).toHaveLength(2);
          assets["/child.js"] = new Blob(
            [source.replace("output.length === bytes", "output.length !== bytes")],
            {
              type: "text/javascript",
            },
          );
        }
        const resultPath = process.env.FS_TRANSPORT_RESULTS_DIR
          ? join(
              process.env.FS_TRANSPORT_RESULTS_DIR,
              `host-${failChild ? "failure" : "complete"}.json`,
            )
          : join(root, "result.json");
        const result = await runPageSuite(
          adapter,
          (path) => (driver = new PlaywrightDriver("chromium", path)),
          {
            resultPath,
            scratchRoot: scratch,
            port: "ephemeral",
            assets,
          },
        );
        expect(result.required).toEqual([id]);
        expect(result.selected).toEqual([id]);
        expect(result.omitted).toEqual([]);
        expect(result.exit).toBe(failChild ? 1 : 0);
        if (failChild)
          expect(JSON.stringify(result.outcomes)).toContain("large private transfer regression");
        else adapter.policy.check(id, result.results[id]);
        expect(await Bun.file(resultPath).json()).toEqual(result);
        for (const step of Object.values(result.cleanup)) {
          if (typeof step === "object") expect(step.status).not.toBe("unconfirmed");
        }
        expect(await readdir(scratch)).toEqual([]);
      } finally {
        await driver?.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    180_000,
  );
}
