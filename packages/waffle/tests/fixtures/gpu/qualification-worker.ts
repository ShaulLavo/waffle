import {
  canvasSize,
  pressureBurst,
  qualificationRequest,
  type QualificationRequest,
} from "./qualification-contract.js";
import { qualifyStableFrame, probeWorkerGpu } from "./qualification-webgpu.js";

type VisibleOwner = { canvas: OffscreenCanvas; context: ImageBitmapRenderingContext };
let visible: VisibleOwner | undefined;
let presentedAt = 0;
let pressureBursts = 0;

function owner(): VisibleOwner {
  if (!visible) throw new Error("Visible canvas is not attached");
  return visible;
}

function attach(canvas: OffscreenCanvas, control: SharedArrayBuffer) {
  if (visible) throw new Error("Visible canvas already attached");
  const context = canvas.getContext("bitmaprenderer");
  if (!context) throw new Error("Worker bitmaprenderer unavailable");
  visible = { canvas, context };
  Atomics.add(new Int32Array(control), 0, 1);
  return {
    kind: "attached",
    realm: "dedicated-worker",
    hasDocument: "document" in globalThis,
    location: globalThis.location.pathname,
    bitmaprenderer: true,
    offscreenCanvas: true,
    width: canvas.width,
  };
}

function sourceBitmap(): ImageBitmap {
  const source = new OffscreenCanvas(canvasSize, canvasSize);
  const context = source.getContext("2d");
  if (!context) throw new Error("2d bitmap source unavailable");
  context.fillStyle = "blue";
  context.fillRect(0, 0, canvasSize, canvasSize);
  context.fillStyle = "red";
  context.fillRect(16, 16, 32, 32);
  return source.transferToImageBitmap();
}

function bitmap(suppressTransfer: boolean) {
  const image = sourceBitmap();
  if (suppressTransfer) image.close();
  else owner().context.transferFromImageBitmap(image);
  presentedAt = performance.now();
  return {
    kind: "bitmap",
    suppressed: suppressTransfer,
    sourceLifetime: "local-to-sourceBitmap",
    bitmapWidth: image.width,
  };
}

function pressure() {
  const checksum = pressureBurst();
  pressureBursts++;
  return {
    kind: "pressure",
    checksum,
    pressureBursts,
    elapsedMs: performance.now() - presentedAt,
    retainedCanvas: owner().canvas.width === canvasSize,
    retainedContext: owner().context.canvas === owner().canvas,
  };
}

async function dispatch(request: QualificationRequest): Promise<unknown> {
  switch (request.kind) {
    case "attach":
      return attach(request.canvas, request.control);
    case "capabilities":
      return probeWorkerGpu();
    case "bitmap":
      return bitmap(request.suppressTransfer);
    case "stable-frame":
      return qualifyStableFrame(owner().context, request.suppressTransfer);
    case "pressure":
      return pressure();
    case "dispose":
      owner().context.transferFromImageBitmap(null);
      visible = undefined;
      return { kind: "disposed", retainedCanvas: false, retainedContext: false };
  }
}

globalThis.onmessage = (event: MessageEvent<unknown>) => {
  void dispatch(qualificationRequest(event.data)).then(
    (value) => globalThis.postMessage({ kind: "reply", value }),
    (error: unknown) => globalThis.postMessage({ kind: "failure", error: String(error) }),
  );
};
