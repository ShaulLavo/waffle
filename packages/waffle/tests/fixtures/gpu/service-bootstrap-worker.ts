import "../../../browser/gpu/service-worker.js";
const host = globalThis as unknown as {
  onmessage: (event: MessageEvent) => void;
  postMessage(value: unknown): void;
};
const receive = host.onmessage;
host.onmessage = (event) => {
  receive(event);
  host.postMessage({ processed: event.data.type });
};
