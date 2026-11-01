import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayBrowserPageRun } from "./network-relay-browser-runner.js";
import { createRelayBrowserFixture } from "./network-relay-fixture.js";
import { runIsolatedPages } from "./isolated-page-runner.js";
import { requireCertificateRejection, type RelayProbe } from "./network-relay-contract.js";

function probe(failures: string[]): RelayProbe {
  return { constructed: 1, ready: 0, streams: 0, fragments: 0, closed: 1, failures };
}

test("a pending certificate probe cannot masquerade as native rejection", () => {
  expect(() => requireCertificateRejection(probe([]))).toThrow();
});

test("an unrelated stream failure cannot masquerade as native certificate rejection", () => {
  const wrongPhase = probe([]);
  wrongPhase.ready = 1;
  wrongPhase.streams = 1;
  expect(() => requireCertificateRejection(wrongPhase)).toThrow();
});

test("one failed readiness observation proves the bad-certificate case", () => {
  expect(() => requireCertificateRejection(probe(["native readiness rejected"]))).not.toThrow();
});

for (const resource of ["browser", "fixture"])
  test(`SIGTERM reports rejected ${resource} cleanup before exiting`, async () => {
    const entry = new URL("./isolated-page-runner.ts", import.meta.url).href;
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
        import { exitAfterBrowserCleanup } from ${JSON.stringify(entry)};
        process.once("SIGTERM", () => {
          void exitAfterBrowserCleanup(${JSON.stringify(resource)}, async () => {
            throw new AggregateError([new Error("owned ${resource} close failed")], "cleanup failed");
          });
        });
        setInterval(() => {}, 1000);
        console.log("ready");
      `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
      reader.releaseLock();
      child.kill("SIGTERM");
      const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code).toBe(1);
      expect(JSON.parse(errors)).toEqual({
        cleanup: resource,
        failed: true,
        error: "AggregateError: cleanup failed",
        errors: [`Error: owned ${resource} close failed`],
      });
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  });

test("relay page keeps a legitimate competing listener and binds its own address", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "relay-port-"));
  const previous = process.env.NETWORK_RELAY_TEST_PORT;
  let owner: ReturnType<typeof Bun.serve> | undefined;
  try {
    owner = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("suite control"),
    });
    process.env.NETWORK_RELAY_TEST_PORT = String(owner.port);
    const run = relayBrowserPageRun("webkit", scratch, new Map());
    await runIsolatedPages({ ...run, sources: {}, names: [] });
    expect(await (await fetch(owner.url)).text()).toBe("suite control");
  } finally {
    if (previous === undefined) delete process.env.NETWORK_RELAY_TEST_PORT;
    else process.env.NETWORK_RELAY_TEST_PORT = previous;
    await owner?.stop(true);
    await rm(scratch, { recursive: true, force: true });
  }
});

test("relay fixture admits only the bound page origin and still requires its token", async () => {
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("page") });
  const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("other") });
  const fixture = createRelayBrowserFixture();
  try {
    const config = await fixture.start(page.url.origin, false);
    const session = (origin: string, token?: string) =>
      fetch(new URL("v1/tcp/session", config.endpoint), {
        method: "POST",
        headers: { origin, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });
    const admitted = await session(page.url.origin, config.token);
    expect(admitted.status).toBe(200);
    expect(await admitted.json()).toEqual({ v: 1, webtransport: null });
    const denied = await session(other.url.origin, config.token);
    expect(denied.status).toBe(403);
    await denied.body?.cancel();
    const unbound = await session("http://127.0.0.1:0", config.token);
    expect(unbound.status).toBe(403);
    await unbound.body?.cancel();
    const unauthorized = await session(page.url.origin);
    expect(unauthorized.status).toBe(401);
    await unauthorized.body?.cancel();
    expect(await (await fetch(page.url)).text()).toBe("page");
    expect(await (await fetch(other.url)).text()).toBe("other");
  } finally {
    await fixture.close();
    await page.stop(true);
    await other.stop(true);
  }
});
