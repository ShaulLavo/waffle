// Bun's registration policy; routing and socket transport are guest-independent.
import { PreviewRouter } from "@bun-wasm/runtime/browser/preview";
import { activated } from "@bun-wasm/runtime/browser/service-worker";
import { PREVIEW_DIR } from "./preview-protocol";

export { activated } from "@bun-wasm/runtime/browser/service-worker";
export type PreviewState = "ready" | "unsupported" | "failed";

export class Previews extends PreviewRouter {
  /** Resolves once the service worker can intercept preview URLs (or registration failed). */
  readonly ready: Promise<PreviewState>;

  constructor() {
    super({ baseURL: location.href, prefix: PREVIEW_DIR });
    this.ready = this.registerWorker();
  }

  private async registerWorker(): Promise<PreviewState> {
    const container = navigator.serviceWorker;
    if (!container) return "unsupported";
    container.addEventListener("message", event => this.onMessage(event));
    container.startMessages();
    try {
      // Keep the playground itself outside this worker's scope (and COOP/COEP untouched).
      const registration = await container.register("./sw.js", { scope: `./${PREVIEW_DIR}/` });
      await activated(registration);
      return "ready";
    } catch (err) {
      console.warn("preview service worker registration failed:", err);
      return "failed";
    }
  }
}
