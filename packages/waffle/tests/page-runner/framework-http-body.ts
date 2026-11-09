import type { IncomingMessage } from "node:http";
export function incomingBody(incoming: IncomingMessage): ReadableStream<Uint8Array> {
  let ended = false;
  let data = (_chunk: Buffer) => {};
  let end = () => {};
  let error = (_error: Error) => {};
  const release = () => {
    incoming.off("data", data);
    incoming.off("end", end);
    incoming.off("error", error);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      data = (chunk) => {
        if (ended) return;
        controller.enqueue(chunk);
        if ((controller.desiredSize ?? 0) <= 0) incoming.pause();
      };
      end = () => {
        if (ended) return;
        ended = true;
        release();
        controller.close();
      };
      error = (value) => {
        if (ended) return;
        ended = true;
        release();
        controller.error(value);
      };
      incoming.on("data", data);
      incoming.once("end", end);
      incoming.once("error", error);
    },
    pull() {
      incoming.resume();
    },
    cancel() {
      ended = true;
      incoming.pause();
      release();
    },
  });
}
