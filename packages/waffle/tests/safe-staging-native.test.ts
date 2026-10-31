import { expect, test } from "bun:test";
import { runSafeStagingNative } from "./safe-staging-native.ts";

const formerFixedPort = 46439;
const realTest = process.env.WAFFLE_SAFE_STAGING_PORT_REGRESSION === "1" ? test : test.skip;

realTest("native staging ignores an occupied former fixed port", async () => {
  let occupier: ReturnType<typeof Bun.serve>;
  try {
    occupier = Bun.serve({
      hostname: "127.0.0.1",
      port: formerFixedPort,
      fetch: () => new Response("task-owned occupier"),
    });
  } catch (error) {
    throw new Error(
      `Cannot reserve former staging port ${formerFixedPort}; refusing to stop an existing listener`,
      { cause: error },
    );
  }

  try {
    await runSafeStagingNative("chromium");
    const response = await fetch(`http://127.0.0.1:${formerFixedPort}`);
    expect(await response.text()).toBe("task-owned occupier");
  } finally {
    occupier.stop(true);
  }
});
