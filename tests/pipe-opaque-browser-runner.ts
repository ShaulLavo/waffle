import { existsSync } from "node:fs";
import { BrowserRunnerLifecycle } from "./browser-runner-lifecycle.ts";

const lifecycle = new BrowserRunnerLifecycle(60_000);
try {
  console.log(
    JSON.stringify({
      sourceHashes: Object.fromEntries(
        await Promise.all(
          ["proc/pipes.ts", "proc/worker-pipes.ts", "tests/pipe-opaque-browser.ts"].map(
            async (path) => [
              path,
              new Bun.CryptoHasher("sha256")
                .update(await Bun.file(path).arrayBuffer())
                .digest("hex"),
            ],
          ),
        ),
      ),
    }),
  );
  await lifecycle.init("/work/tmp");
  const main = await Bun.build({
    entrypoints: ["tests/pipe-opaque-browser.ts"],
    target: "browser",
    format: "esm",
  });
  const pipes = await Bun.build({
    entrypoints: ["proc/pipes.ts"],
    target: "browser",
    format: "esm",
  });
  if (!main.success || !pipes.success)
    throw new AggregateError(main.logs.concat(pipes.logs), "pipe proof bundle");
  const url = lifecycle.serve({
    "/": '<script type="module">import {runOpaquePipeProof} from "/proof.js"; window.proof = runOpaquePipeProof();</script>',
    "/proof.js": main.outputs[0]!,
    "/pipes.js": pipes.outputs[0]!,
  });
  const browser = await lifecycle.launch("chromium");
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error(error));
  await page.goto(url);
  const result = await page.evaluate("window.proof");
  console.log(JSON.stringify({ browser: browser.version(), result }));
} finally {
  const scratch = lifecycle.scratch;
  await lifecycle.close();
  console.log(
    JSON.stringify({
      cleanup: "closed browser/server",
      scratch,
      scratchExists: existsSync(scratch),
    }),
  );
}
