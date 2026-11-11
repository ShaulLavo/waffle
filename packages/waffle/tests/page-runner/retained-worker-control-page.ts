import { startPage } from "./page-main.js";
import { cleanupStorage } from "./storage-cleanup.js";
import { storageLockCases } from "../storage-lock-cases.js";
import type { StorageLockRequest } from "../storage-lock-host.js";

declare const RETAINED_CONTROL: string;
const item = storageLockCases[17];
if (!item) throw new Error("Missing original case 18");
startPage<StorageLockRequest>({
  list: async () => [item.id],
  run: {
    kind: "host",
    peer: async (request, allocate) => {
      const path = "/fixture.js";
      const fixture: typeof import("../storage-lock-browser.js") = await import(path);
      fixture.lockTest.configure({ name: () => request.name, allocate });
      if (RETAINED_CONTROL === "retained-worker-wrong-path")
        fixture.lockTest.configureRecoveryURL("/wrong-recovery-fs-worker.js");
    },
    teardown: async () => true,
  },
  finish: cleanupStorage,
});
