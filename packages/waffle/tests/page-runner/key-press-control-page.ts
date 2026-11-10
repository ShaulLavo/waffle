import { startPage } from "waffle/testing/page-runner/page";
import { installKeyControl } from "./key-press-fixture.js";
import { keyControlId } from "./key-press-observation.js";

startPage<null>({
  list: async () => ({ ids: [keyControlId] }),
  run: {
    kind: "host",
    async teardown() {
      window.__keyControl.dispose();
      return { disposed: true, textareas: document.querySelectorAll("textarea").length };
    },
  },
  finish: async (ledger) => ledger.slice(),
});
// Setup belongs to the original page fixture, not to the input driver.
window.__keyControl = installKeyControl();
