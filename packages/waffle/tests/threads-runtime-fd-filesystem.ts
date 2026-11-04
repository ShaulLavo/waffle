import { MemoryBackend } from "../fs/backend.ts";
import { installFilesystemWorker } from "../fs/service.ts";
import type { DescriptorCase } from "./threads-runtime-fd-module.ts";

const released = Promise.withResolvers<void>();
let selected: DescriptorCase | undefined;
let reads = 0;
let held = false;
class HeldBackend extends MemoryBackend {
  prepare(operation: string, args: unknown[]): Promise<void> | undefined {
    if (held || operation !== selected) return;
    if (operation === "read" && args[1] === 2 && args[2] === 0 && ++reads === 2)
      return this.hold(operation, args);
    if (operation === "write" && args[1] === 0) return this.hold(operation, args);
  }
  private async hold(operation: string, args: unknown[]): Promise<void> {
    held = true;
    self.postMessage({ kind: "fd-held", operation, args });
    await released.promise;
    self.postMessage({ kind: "fd-released" });
  }
}
installFilesystemWorker(
  self,
  (options) =>
    new HeldBackend(undefined, undefined, options.startupRoot, undefined, options.connect),
);
const receive = self.onmessage;
self.onmessage = (event: MessageEvent) => {
  const data: unknown = event.data;
  if (data && typeof data === "object" && "kind" in data) {
    if (data.kind === "fd-release") return released.resolve();
    if (data.kind === "fd-arm" && "selected" in data) {
      if (data.selected !== "read" && data.selected !== "write") throw new Error("invalid fd case");
      selected = data.selected;
      self.postMessage({ kind: "fd-armed" });
      return;
    }
  }
  receive?.call(self, event);
};
