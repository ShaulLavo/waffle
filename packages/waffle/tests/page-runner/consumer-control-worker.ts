import { chunkMarker } from "./consumer-control-chunk.js";
if (typeof document === "undefined") {
  globalThis.onmessage = () => globalThis.postMessage(chunkMarker);
}
