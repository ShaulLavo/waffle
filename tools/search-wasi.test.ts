import { createRuntime } from "@waffle-os/runtime";
import { test } from "bun:test";
import { grep } from "../packages/grep/src/index.ts";
import { ripgrep } from "../packages/ripgrep/src/index.ts";
import { checkSearchStreams, withProgramAcceptance } from "./family-acceptance.ts";

test("grep and ripgrep WASI stream large inputs and outputs", async () => {
  const runtime = createRuntime({
    filesystem: {
      mode: "memory",
      workerURL: new URL("../packages/waffle/browser/fs-worker.ts", import.meta.url),
    },
  });
  try {
    await withProgramAcceptance(
      {
        runtime,
        workerUrl: new URL("../packages/waffle/browser/preview1-worker.ts", import.meta.url),
        packages: [grep, ripgrep],
        redirectFiles: true,
      },
      async (session) => {
        await checkSearchStreams(session, "grep", ["-raF"]);
        await checkSearchStreams(session, "rg", [
          "--color=never",
          "--no-ignore",
          "--hidden",
          "--text",
          "-F",
        ]);
      },
    );
  } finally {
    await runtime.dispose();
  }
}, 90_000);
