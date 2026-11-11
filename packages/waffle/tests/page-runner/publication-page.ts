import { startPage } from "./page-main.js";
import { installPublicationBootstrap } from "./publication-bootstrap.js";
import { publicationId, type PublicationMode } from "../publication-command.js";

declare const PUBLICATION_MODE: PublicationMode;

installPublicationBootstrap();
let pending: Promise<void> | undefined;
let value: string[] | null = null;
async function command(mode: PublicationMode): Promise<string[]> {
  const path = "/tests.js";
  if (mode === "workspace") {
    const fixture: typeof import("../workspace-browser.js") = await import(path);
    return fixture.runWorkspaceBrowser();
  }
  const fixture: typeof import("../publication-browser.js") = await import(path);
  return fixture.runPublicationBrowser();
}
async function run(mode: PublicationMode): Promise<void> {
  if (pending) throw new Error("Publication command already started");
  pending = command(mode).then((labels) => {
    value = labels;
  });
  await pending;
}
declare global {
  interface Window {
    __publicationCommand: { run: typeof run; result(): unknown };
  }
}
window.__publicationCommand = { run, result: () => value };
startPage<{ mode: PublicationMode }>({
  list: async () => ({ ids: [publicationId(PUBLICATION_MODE)] }),
  run: {
    kind: "host",
    peer: async () => {},
    async teardown() {
      await pending;
      return { settled: true };
    },
  },
  async finish(ledger) {
    if (ledger.length) throw new Error("Original publication command owns its database cleanup");
    return [];
  },
});
