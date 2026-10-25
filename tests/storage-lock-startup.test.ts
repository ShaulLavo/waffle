import { expect, mock, test } from "bun:test";
import type { Page } from "playwright";
import {
  storageLockNavigate,
  type StorageLockNavigationDiagnostic,
} from "./fixtures/storage-lock-startup.ts";

function navigationFixture() {
  let closed = false;
  const page = {
    on: mock<(event: string, listener: (...args: never[]) => void) => Page>(),
    off: mock<(event: string, listener: (...args: never[]) => void) => Page>(),
    goto: mock<Page["goto"]>().mockResolvedValue(null),
    url: () => "about:blank",
    isClosed: () => closed,
    close: mock(async () => {
      closed = true;
    }),
  };
  return { page, context: { newPage: async () => page } };
}

function expectListenersRemoved(page: ReturnType<typeof navigationFixture>["page"]) {
  expect(page.on.mock.calls.map(([event]) => event)).toEqual([
    "request",
    "response",
    "requestfailed",
    "load",
    "domcontentloaded",
    "crash",
    "pageerror",
  ]);
  expect(page.off.mock.calls).toEqual(page.on.mock.calls);
}

for (const closeFails of [false, true]) {
  test(`failed navigation closes its unreturned page and preserves the rejection, closeFails=${closeFails}`, async () => {
    const { page, context } = navigationFixture();
    const navigationError = new Error("labelled navigation failure");
    const report = mock<(diagnostic: StorageLockNavigationDiagnostic) => void>();
    page.goto.mockRejectedValue(navigationError);
    if (closeFails) page.close.mockRejectedValue(new Error("labelled close failure"));

    await expect(
      storageLockNavigate(context, "http://navigation.invalid/fixture", report),
    ).rejects.toBe(navigationError);

    expect(page.close).toHaveBeenCalledTimes(1);
    expect(page.isClosed()).toBe(!closeFails);
    expect(report.mock.calls).toEqual([
      [{ phase: "navigation", target: "/fixture", current: "blank", closed: false, events: [] }],
    ]);
    expectListenersRemoved(page);
  });
}

test("successful navigation leaves the returned page open for its caller and removes listeners", async () => {
  const { page, context } = navigationFixture();
  const report = mock<(diagnostic: StorageLockNavigationDiagnostic) => void>();

  expect(await storageLockNavigate(context, "http://navigation.invalid/fixture", report)).toBe(
    page,
  );

  expect(page.goto).toHaveBeenCalledWith("http://navigation.invalid/fixture");
  expect(page.close).not.toHaveBeenCalled();
  expect(page.isClosed()).toBe(false);
  expect(report).not.toHaveBeenCalled();
  expectListenersRemoved(page);
});
