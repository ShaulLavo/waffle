// Page side of Bun.serve previews: registers the service worker (sw.ts), keeps track of which
// running worker serves which port, and answers the service worker's requests through NetHelper.

import type { NetHelper } from "./net/helper";
import { PREVIEW_DIR, type PreviewAsk, type PreviewReply } from "./preview-protocol";

export type PreviewState = "ready" | "unsupported" | "failed";

export class Previews {
  private servers = new Map<number, NetHelper>();
  /** Resolves once the service worker can intercept preview URLs (or registration failed). */
  readonly ready: Promise<PreviewState>;

  constructor() {
    this.ready = this.registerWorker();
  }

  url(port: number, path = "/"): string {
    return new URL(`${PREVIEW_DIR}/${port}${path}`, location.href).href;
  }

  serves(port: number): boolean {
    return this.servers.has(port);
  }

  register(port: number, helper: NetHelper): void {
    this.servers.set(port, helper);
  }

  unregister(port: number, helper: NetHelper): void {
    if (this.servers.get(port) === helper) this.servers.delete(port);
  }

  private async registerWorker(): Promise<PreviewState> {
    const container = navigator.serviceWorker;
    if (!container) return "unsupported";
    container.addEventListener("message", (event: MessageEvent<PreviewAsk>) => this.onAsk(event));
    container.startMessages();
    try {
      // The scope keeps the playground page itself out of the worker's control.
      const registration = await container.register("./sw.js", { scope: `./${PREVIEW_DIR}/` });
      // `container.ready` never resolves here (this page is outside the scope): watch the worker.
      await activated(registration);
      return "ready";
    } catch (err) {
      console.warn("preview service worker registration failed:", err);
      return "failed";
    }
  }

  private onAsk(event: MessageEvent<PreviewAsk>): void {
    const ask = event.data;
    const reply = event.ports[0];
    if (ask?.type !== "preview-request" || !reply) return;
    const send = (msg: PreviewReply, transfer: Transferable[] = []) => reply.postMessage(msg, transfer);
    const helper = this.servers.get(ask.port);
    const request = { method: ask.method, target: ask.target, headers: ask.headers, body: ask.body ? new Uint8Array(ask.body) : null };
    const accepted = helper?.request(ask.port, request, {
      head: (head) => send({ type: "head", ...head }),
      data: (chunk) => send({ type: "data", chunk }, [chunk.buffer]),
      end: () => send({ type: "end" }),
      error: (message) => send({ type: "error", message }),
    });
    send({ type: accepted ? "accepted" : "none" });
  }
}

function activated(registration: ServiceWorkerRegistration): Promise<void> {
  const worker = registration.installing ?? registration.waiting;
  if (!worker || registration.active) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (worker.state !== "activated" && worker.state !== "redundant") return;
      worker.removeEventListener("statechange", check);
      resolve();
    };
    worker.addEventListener("statechange", check);
    check();
  });
}
