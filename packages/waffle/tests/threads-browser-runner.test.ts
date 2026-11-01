import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareThreadsBrowser, threadBrowserSources } from "./threads-browser-runner.ts";
import { threadBrowserModes } from "./threads-browser-contract.ts";
import { runThreadsSafari } from "./threads-safari-runner.ts";

const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
async function packet(directory: string) {
  const assets = [];
  for (const path of Object.keys(threadBrowserSources).map((path) => path.slice(1))) {
    const source = "// driver-boundary unit input, never executed in a browser\n";
    await Bun.write(join(directory, path), source);
    assets.push({ path, sha256: hash(source) });
  }
  await Bun.write(join(directory, "threads.wasm"), "unit input");
  await Bun.write(join(directory, "threads.receipt.json"), "unit receipt");
  await Bun.write(
    join(directory, "manifest.json"),
    JSON.stringify({
      assets,
      fixtureSha256: hash("unit input"),
      receiptSha256: hash("unit receipt"),
    }),
  );
}
test("missing producer receipt fails before creating a packet or invoking a compiler", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "thread-runner-"));
  try {
    const destination = join(scratch, "packet");
    await expect(prepareThreadsBrowser(destination, join(scratch, "absent"))).rejects.toThrow();
    expect(await Bun.file(join(destination, "manifest.json")).exists()).toBe(false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
test("Safari packet refuses changed script bytes before contacting a driver", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "thread-runner-"));
  try {
    await packet(scratch);
    await Bun.write(join(scratch, "threads-guest.js"), "changed");
    await expect(runThreadsSafari(scratch, "http://127.0.0.1:1", 0)).rejects.toThrow(
      "packet digest mismatch",
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
test("a non-Safari session is rejected and its owned session is deleted", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "thread-runner-"));
  let deleted = 0;
  const driver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.method === "DELETE") {
        deleted++;
        return Response.json({ value: null });
      }
      return Response.json({
        value: { sessionId: "unit-session", capabilities: { browserName: "not-Safari" } },
      });
    },
  });
  try {
    await packet(scratch);
    await expect(runThreadsSafari(scratch, driver.url.href.replace(/\/$/, ""), 0)).rejects.toThrow(
      "not actual Safari",
    );
    expect(deleted).toBe(1);
  } finally {
    driver.stop(true);
    await rm(scratch, { recursive: true, force: true });
  }
});

test("case selection is bounded to the unchanged stock fixture modes", () => {
  expect(threadBrowserModes()).toEqual(["pair", "repeat", "nested"]);
  expect(threadBrowserModes("repeat")).toEqual(["repeat"]);
  expect(() => threadBrowserModes("other")).toThrow("expected pair, repeat, or nested");
});
