import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { navigateTestPage, type NavigationPage } from "./browser-navigation.js";

function fixture(engine = "webkit") {
  const browserType = { name: () => engine };
  const browser = { browserType: () => browserType };
  const context = { browser: () => browser };
  const page = {
    context: () => context,
    goto: mock<Page["goto"]>().mockResolvedValue(null),
    route: mock<Page["route"]>().mockResolvedValue({
      dispose: async () => {},
      [Symbol.asyncDispose]: async () => {},
    }),
    unroute: mock<Page["unroute"]>().mockResolvedValue(),
  } satisfies NavigationPage;
  return page;
}

test("WebKit admission uses the original navigation options and removes only its own route", async () => {
  const page = fixture();
  const options = { timeout: 15_000, waitUntil: "load" } as const;
  await navigateTestPage(page, "http://127.0.0.1:1234#fixture", options);
  expect(page.goto).toHaveBeenCalledTimes(1);
  expect(page.goto).toHaveBeenCalledWith("http://127.0.0.1:1234#fixture", options);
  const [matches, resume, routeOptions] = page.route.mock.calls[0]!;
  // A RegExp is matched in Playwright's server, so the page's other requests are never
  // intercepted and reported to the client while the route exists. A predicate would be.
  if (!(matches instanceof RegExp)) throw new Error("Expected a serializable URL pattern");
  expect(matches.test("http://127.0.0.1:1234/")).toBe(true);
  expect(matches.test("http://127.0.0.1:1234/other")).toBe(false);
  expect(matches.test("http://127.0.0.1:1234/?")).toBe(false);
  expect(matches.test("http://127.0.0.1:12345/")).toBe(false);
  // An expiring route breaks context routes that continue the request (Playwright 1.64.1).
  expect(routeOptions).toBeUndefined();
  expect(page.unroute).toHaveBeenCalledWith(matches, resume);
});

test("WebKit admission matches query characters literally", async () => {
  const page = fixture();
  const target = "http://127.0.0.1:1234/_waffle_observation_bootstrap?token=a.b+c(d)";
  await navigateTestPage(page, target);
  const [matches] = page.route.mock.calls[0]!;
  if (!(matches instanceof RegExp)) throw new Error("Expected a serializable URL pattern");
  expect(matches.test(new URL(target).href)).toBe(true);
  expect(matches.test("http://127.0.0.1:1234/_waffle_observation_bootstrap?token=aXb+c(d)")).toBe(
    false,
  );
  expect(matches.test("http://127.0.0.1:1234/_waffle_observation_arrival?token=a.b+c(d)")).toBe(
    false,
  );
});

for (const failure of [
  Object.assign(new Error("Timeout 15000ms exceeded."), { name: "TimeoutError" }),
  new Error("net::ERR_ABORTED"),
]) {
  test(`the route is removed after a ${failure.name} navigation failure`, async () => {
    const page = fixture();
    page.goto.mockRejectedValue(failure);
    await expect(navigateTestPage(page, "http://127.0.0.1/")).rejects.toBe(failure);
    const [matches, resume] = page.route.mock.calls[0]!;
    expect(page.unroute).toHaveBeenCalledWith(matches, resume);
  });
}

test("an unrelated navigation failure stays the original failure, even if cleanup fails", async () => {
  const page = fixture();
  const failure = new Error("real navigation failure");
  page.goto.mockRejectedValue(failure);
  page.unroute.mockRejectedValue(new Error("page closed during teardown"));
  await expect(navigateTestPage(page, "http://127.0.0.1/")).rejects.toBe(failure);
  expect(page.goto).toHaveBeenCalledTimes(1);
  expect(page.unroute).toHaveBeenCalledTimes(1);
});

for (const engine of ["chromium", "firefox"]) {
  test(`${engine} keeps its original navigation and cache behavior`, async () => {
    const page = fixture(engine);
    await navigateTestPage(page, "http://127.0.0.1/");
    expect(page.goto).toHaveBeenCalledWith("http://127.0.0.1/");
    expect(page.route).not.toHaveBeenCalled();
    expect(page.unroute).not.toHaveBeenCalled();
  });
}

test("about:blank does not install a network route", async () => {
  const page = fixture();
  await navigateTestPage(page, "about:blank");
  expect(page.goto).toHaveBeenCalledWith("about:blank");
  expect(page.route).not.toHaveBeenCalled();
});

test("browser fixtures use the shared navigation admission helper", () => {
  const direct = [];
  for (const path of new Bun.Glob("**/*.ts").scanSync(import.meta.dir)) {
    // The original diagnostic must keep reproducing the unmodified upstream bug.
    if (path === "browser-navigation.ts" || path === "process-root-navigation-diagnostic.ts")
      continue;
    if (/[.]goto\s*[(]/.test(readFileSync(join(import.meta.dir, path), "utf8"))) direct.push(path);
  }
  expect(direct).toEqual([]);
});
