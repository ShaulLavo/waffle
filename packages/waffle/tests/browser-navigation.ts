import type { Page, Route } from "playwright";

export type NavigationPage = Pick<Page, "goto" | "route" | "unroute"> & {
  context(): { browser(): { browserType(): { name(): string } } | null };
};

function navigate(
  page: NavigationPage,
  target: string,
  options?: Parameters<Page["goto"]>[1],
): ReturnType<Page["goto"]> {
  return options === undefined ? page.goto(target) : page.goto(target, options);
}

export async function navigateTestPage(
  page: NavigationPage,
  target: string,
  options?: Parameters<Page["goto"]>[1],
): ReturnType<Page["goto"]> {
  if (page.context().browser()?.browserType().name() !== "webkit" || !/^https?:/.test(target))
    return navigate(page, target, options);

  // WebKit 325840 lets a COOP response overtake the old process's load-start IPC.
  // Request interception admits that IPC before the real network request continues.
  // Remove when Playwright ships https://github.com/WebKit/WebKit/pull/75569.
  const url = new URL(target);
  url.hash = "";
  const matches = (candidate: URL) => candidate.href === url.href;
  const resume = (route: Route) => route.fallback();
  await page.route(matches, resume, { times: 1 });
  let failed = false;
  try {
    return await navigate(page, target, options);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const cleanup = page.unroute(matches, resume);
    if (failed) await cleanup.catch(() => {});
    else await cleanup;
  }
}
