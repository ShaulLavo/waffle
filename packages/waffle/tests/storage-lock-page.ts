import { startPage } from "./page-runner/page-main.js";
import { cleanupStorage } from "./page-runner/storage-cleanup.js";
import { storageLockCases } from "./storage-lock-cases.js";
import type { StorageLockRequest } from "./storage-lock-host.js";

startPage<StorageLockRequest>({
  list: async () => storageLockCases.map((item) => item.id),
  run: {
    kind: "host",
    peer: async (request, allocate) => {
      const path = "/fixture.js";
      const { lockTest }: typeof import("./storage-lock-browser.js") = await import(path);
      lockTest.configure({ name: () => request.name, allocate });
    },
    teardown: async () => ({ coordinatorOpenedStorage: false }),
  },
  finish: cleanupStorage,
});
