import { startPage, cleanupStorage } from "waffle/testing/page-runner/page";
import { networkBrowserCases } from "./network-browser.js";
import { finishNetworkCase } from "./network-finalizer.js";

startPage<string>({
  list: async () => ["network-control"],
  async run(mode) {
    if (mode === "scope-only")
      return networkBrowserCases({
        serviceWorker: {
          register: () =>
            navigator.serviceWorker.register("/network-sw.js", {
              scope: `/_negative/${crypto.randomUUID()}/`,
              type: "module",
            }),
          controls: (registration, controller) => controller === registration.active,
          unregister: (registration) => registration.unregister(),
        },
      });
    const primary = new Error("PRIMARY_ASSERTION");
    await finishNetworkCase(
      { error: primary },
      ["guest 1", "guest 2", "unregister", "listener", "namespace", "runtime"].map(
        (label) => () => {
          throw new Error(`CLEANUP_${label}`);
        },
      ),
    );
  },
  finish: cleanupStorage,
});
