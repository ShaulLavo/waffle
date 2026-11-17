import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Collector } from "./collector.js";
import { bounded, type DriverObservation } from "./driver.js";
import { HostConsumers } from "./owned-consumers.js";
import { PlaywrightDriver } from "./playwright-driver.js";
import { serveCollector } from "./suite-host.js";

class ArrivalControlDriver extends PlaywrightDriver {
  readonly joining = Promise.withResolvers<void>();
  readonly trace: string[] = [];
  override async script(source: string, signal: AbortSignal): Promise<unknown> {
    if (!source.includes("__waffleObservationArrival")) return super.script(source, signal);
    this.joining.resolve();
    const result = await super.script(source, signal);
    this.trace.push("response-settled");
    return result;
  }
}

type Control = "healthy" | "missing" | "transport";
async function arrivalControl(control: Control): Promise<void> {
  const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "bac-"));
  const driver = new ArrivalControlDriver("webkit", root);
  const collector = new Collector("run", ["case"], ["case"], {
    listIds: () => ["case"],
    check() {},
  });
  const fixture = serveCollector(collector, {}, undefined, 0);
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/next")
        return new Response("<!doctype html><title>Next</title>", {
          headers: { "Content-Type": "text/html" },
        });
      if (url.pathname !== "/_waffle_observation_arrival")
        return fetch(fixture.origin + url.pathname + url.search);
      if (control === "missing") {
        // Answer from a later task. A reply written in the same tick the request arrives,
        // on the keep-alive connection that just served the bootstrap page, can fail to
        // reach the WebKit page (on one core, about 1 in 5 runs) until the server's idle
        // close makes WebKit retry, so the arrival probe would time out instead.
        await Bun.sleep(1);
        received.resolve();
        return new Response("Missing arrival", { status: 410 });
      }
      const response = await fetch(fixture.origin + url.pathname + url.search);
      driver.trace.push("request-received");
      received.resolve();
      await release.promise;
      driver.trace.push("response-released");
      return response;
    },
  });
  const origin = `http://127.0.0.1:${proxy.port}`;
  const state = collector.expect(
    { id: "case", role: "case", caseIds: ["case"], execution: "host" },
    "exact-token",
    origin + "/next",
    "root",
  );
  fixture.configurations.set(state.token, {});
  const bootstrapURL = origin + "/_waffle_observation_bootstrap?token=" + state.token;
  const signal = AbortSignal.timeout(60_000);
  let navigation: Promise<void> | undefined;
  let observation: DriverObservation | undefined;
  try {
    await driver.start(signal);
    navigation = driver.navigate(bootstrapURL, signal);
    void navigation.catch(() => {});
    await bounded(received.promise, 30_000, "arrival request");
    await bounded(driver.joining.promise, 30_000, "arrival response ownership");
    if (control === "missing") {
      await expect(navigation).rejects.toThrow("Bootstrap arrival HTTP 410");
      const owner = new AbortController();
      const waiting = collector.waitForBootstrap(state, owner.signal);
      owner.abort(new Error("Missing arrival control"));
      await expect(waiting).rejects.toThrow("Missing arrival control");
      return;
    }
    await collector.waitForBootstrap(state, signal);
    expect(await driver.script("return document.readyState", signal)).toBe("complete");
    expect(driver.trace).toEqual(["request-received"]);
    if (control === "transport") {
      await proxy.stop(true);
      await expect(navigation).rejects.toThrow("Load failed");
      expect(driver.uncertain).toBe(true);
      return;
    }
    release.resolve();
    await navigation;
    observation = await driver.observe({
      bootstrapURL,
      expectedURL: state.expectedURL,
      window: "root",
      signal,
      consumers: new HostConsumers(),
      console: true,
    });
    driver.trace.push("observation-active", "next-navigation");
    await driver.navigate(state.expectedURL, signal);
    observation.navigationComplete();
    await observation.settleConsole?.();
    expect(observation.console?.().first).toBeNull();
    expect(collector.failures).toEqual([]);
    expect(driver.trace).toEqual([
      "request-received",
      "response-released",
      "response-settled",
      "observation-active",
      "next-navigation",
    ]);
  } finally {
    release.resolve();
    await observation?.stop();
    const cleanup = await driver.stop();
    await navigation?.catch(() => {});
    collector.cancel();
    await proxy.stop(true);
    await fixture.server.stop(true);
    await rm(root, { recursive: true, force: true });
    expect(cleanup.session.status).toBe("confirmed");
    expect(cleanup.launcher.status).toBe("confirmed");
  }
}

for (const control of ["healthy", "missing", "transport"] as const)
  test.skipIf(process.env.BOOTSTRAP_ARRIVAL_BROWSER_CONTROLS !== "1")(
    `native WebKit bootstrap settlement preserves ${control} arrival`,
    () => arrivalControl(control),
    90_000,
  );
