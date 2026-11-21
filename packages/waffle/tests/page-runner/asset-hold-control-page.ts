import { startPage, cleanupStorage } from "@waffle-os/runtime/testing/page-runner/page";

startPage({
  list: async () => ["shell", "unheld-shell", "unheld-guest", "guest"],
  run: { kind: "host", teardown: async (_request, verdict) => ({ status: verdict.status }) },
  finish: cleanupStorage,
});
