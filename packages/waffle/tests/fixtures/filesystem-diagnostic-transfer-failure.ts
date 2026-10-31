import { installFilesystemWorker } from "../../fs/service";

const scope: {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
} = {
  onmessage: null,
  postMessage() {
    throw new Error("Diagnostic transfer refused");
  },
};
installFilesystemWorker(scope, async () => {
  throw new Error("Original filesystem startup failure");
});
self.onmessage = (event) => scope.onmessage?.(event);
