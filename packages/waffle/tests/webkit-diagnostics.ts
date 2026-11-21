import type { Page } from "playwright";

export function webKitDebugFilter(debug: string | undefined): string {
  return debug ? `${debug},pw:browser` : "pw:browser";
}

export function observeWebKitPage(page: Page, control: string) {
  let phase = "opened";
  const report = (event: "close" | "crash" | "failure") => {
    console.error(
      JSON.stringify({
        webkitPage: control,
        event,
        phase,
        url: page.url().split("?")[0],
        closed: page.isClosed(),
        browserConnected: page.context().browser()?.isConnected() ?? null,
      }),
    );
  };
  page.once("close", () => report("close"));
  page.once("crash", () => report("crash"));
  return {
    enter(next: string) {
      phase = next;
    },
    fail() {
      report("failure");
    },
  };
}
