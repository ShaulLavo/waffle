import { installFilesystemWorker } from "../../fs/service.js";

installFilesystemWorker(self, async (options) => {
  if (options.reason === "hostile")
    throw {
      toString() {
        throw new Error("conversion failed");
      },
      get stack() {
        throw new Error("stack failed");
      },
    };
  if (options.reason === "null-prototype") throw Object.create(null);
  if (options.reason === "hostile-stack") {
    const error = new Error("Filesystem fixture stack is unavailable");
    Object.defineProperty(error, "stack", {
      get() {
        throw new Error("stack failed");
      },
    });
    throw error;
  }
  throw new Error("Filesystem fixture cannot open storage");
});
