import {
  assertImagePixel,
  assertUpload,
  distribution,
  measure,
  measurementRequest,
  unavailableMemory,
  type MeasurementOptions,
  type MeasurementRequest,
} from "./measurement-contract.js";
import { probeWorkerGpu } from "./qualification-webgpu.js";

declare const GPUBufferUsage: { COPY_SRC: number; COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number };
let device: GPUDevice | undefined;
let devicesCreated = 0;
let buffersLive = 0;
let canvasesLive = 0;

async function openDevice() {
  if (device) throw new Error("Device already open");
  if (!navigator.gpu) return { kind: "unsupported", reason: "Worker navigator.gpu unavailable" };
  const start = performance.now();
  const adapter = await navigator.gpu.requestAdapter();
  const adapterMs = performance.now() - start;
  if (!adapter) return { kind: "unsupported", reason: "Worker requestAdapter returned null" };
  const requested = performance.now();
  device = await adapter.requestDevice();
  devicesCreated++;
  return {
    kind: "measured",
    value: {
      adapterMs,
      deviceMs: performance.now() - requested,
      info: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description },
      limits: Object.fromEntries(Array.from(limitKeys, (key) => [key, device!.limits[key]])),
      features: Array.from(device.features),
      devicesLive: 1,
      physicalMemory: unavailableMemory(),
    },
  };
}
const limitKeys = [
  "maxBufferSize",
  "maxTextureDimension2D",
  "maxBindGroups",
  "maxStorageBufferBindingSize",
] as const;
function requireDevice(): GPUDevice {
  if (!device) throw new Error("No measurement device");
  return device;
}
async function uploadTrial(
  gpu: GPUDevice,
  expected: Uint32Array,
  source: GPUBuffer,
  target: GPUBuffer,
  corrupt: boolean,
) {
  const start = performance.now();
  gpu.queue.writeBuffer(source, 0, expected);
  const writeBufferMs = performance.now() - start;
  const encoder = gpu.createCommandEncoder();
  encoder.copyBufferToBuffer(source, 0, target, 0, expected.byteLength);
  gpu.queue.submit([encoder.finish()]);
  await target.mapAsync(GPUMapMode.READ);
  try {
    const actual = new Uint32Array(target.getMappedRange());
    if (corrupt) expected[0] = expected[0]! ^ 1;
    assertUpload(actual, expected);
  } finally {
    target.unmap();
  }
  return { writeBufferMs, uploadAndReadbackMs: performance.now() - start };
}
async function uploads(options: MeasurementOptions, corrupt: boolean) {
  const gpu = requireDevice();
  const expected = new Uint32Array(new SharedArrayBuffer(64 * 1024));
  const source = gpu.createBuffer({
    size: expected.byteLength,
    usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  const target = gpu.createBuffer({
    size: expected.byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  buffersLive += 2;
  try {
    const writes: number[] = [];
    const roundtrips: number[] = [];
    for (let trial = 0; trial < options.warmup + options.trials; trial++) {
      expected.forEach((_, index) => {
        expected[index] = (index * 2654435761 + trial) >>> 0;
      });
      const result = await uploadTrial(gpu, expected, source, target, corrupt);
      if (trial < options.warmup) continue;
      writes.push(result.writeBufferMs);
      roundtrips.push(result.uploadAndReadbackMs);
    }
    return {
      source: "SharedArrayBuffer view",
      bytes: expected.byteLength,
      checkedEveryWord: true,
      writeBuffer: distribution(writes),
      uploadAndReadback: distribution(roundtrips),
    };
  } finally {
    source.destroy();
    target.destroy();
    buffersLive -= 2;
  }
}
function imageTrial(
  gpu: GPUDevice,
  source: OffscreenCanvas,
  context: GPUCanvasContext,
  target: OffscreenCanvas,
  sink: ImageBitmapRenderingContext,
  red: number,
  suppress: boolean,
) {
  const encoder = gpu.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: context.getCurrentTexture().createView(),
        clearValue: { r: red / 255, g: 1 - red / 255, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });
  pass.end();
  gpu.queue.submit([encoder.finish()]);
  const before = performance.now();
  const image = source.transferToImageBitmap();
  const transferred = performance.now();
  if (suppress) image.close();
  else sink.transferFromImageBitmap(image);
  const consumed = performance.now();
  const output = target.transferToImageBitmap();
  try {
    const read = new OffscreenCanvas(1, 1).getContext("2d");
    if (!read) throw new Error("Pixel verification context unavailable");
    read.drawImage(output, 0, 0, 1, 1);
    assertImagePixel(Array.from(read.getImageData(0, 0, 1, 1).data), red);
  } finally {
    output.close();
  }
  return {
    toBitmapMs: transferred - before,
    fromBitmapMs: consumed - transferred,
    totalMs: consumed - before,
  };
}
async function images(request: Extract<MeasurementRequest, { kind: "image" }>) {
  const gpu = requireDevice();
  const { width, height, options, suppress } = request;
  const source = new OffscreenCanvas(width, height);
  const target = new OffscreenCanvas(width, height);
  const context = source.getContext("webgpu");
  const sink = target.getContext("bitmaprenderer");
  if (!(context instanceof GPUCanvasContext) || !sink)
    throw new Error("Worker WebGPU OffscreenCanvas/bitmaprenderer unavailable");
  canvasesLive += 2;
  try {
    context.configure({
      device: gpu,
      format: navigator.gpu.getPreferredCanvasFormat(),
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
      alphaMode: "opaque",
    });
    const to: number[] = [],
      from: number[] = [],
      total: number[] = [];
    for (let trial = 0; trial < options.warmup + options.trials; trial++) {
      const sample = imageTrial(gpu, source, context, target, sink, trial % 2 ? 255 : 0, suppress);
      await gpu.queue.onSubmittedWorkDone();
      if (trial < options.warmup) continue;
      to.push(sample.toBitmapMs);
      from.push(sample.fromBitmapMs);
      total.push(sample.totalMs);
    }
    return {
      width,
      height,
      transferToImageBitmap: distribution(to),
      transferFromImageBitmap: distribution(from),
      synchronousTransferPair: distribution(total),
      pixelVerified: true,
      timing:
        "Native synchronous calls only; render, readback verification and GPU completion wait excluded. Not a presentation/compositor latency measurement.",
    };
  } finally {
    context.unconfigure();
    source.width = target.width = 1;
    canvasesLive -= 2;
  }
}
async function wait(request: Extract<MeasurementRequest, { kind: "wait" }>) {
  if (typeof Atomics.waitAsync !== "function") throw new Error("Atomics.waitAsync unavailable");
  const cells = new Int32Array(request.control, 0, 2);
  const pending = Atomics.waitAsync(cells, 0, 0, request.timeoutMs);
  globalThis.postMessage({ kind: "armed", async: pending.async });
  const result = await pending.value;
  const elapsedMs =
    performance.timeOrigin + performance.now() - new Float64Array(request.control, 8, 1)[0]!;
  return { async: pending.async, result, elapsedMs, notified: Atomics.load(cells, 1) };
}
async function checkedGpu<T>(operation: () => Promise<T>): Promise<T> {
  const gpu = requireDevice();
  gpu.pushErrorScope("validation");
  const outcome = await measure(operation);
  const error = await gpu.popErrorScope();
  if (outcome.kind !== "measured") throw new Error(outcome.reason);
  if (error) throw new Error(error.message);
  return outcome.value;
}
async function dispatch(request: MeasurementRequest): Promise<unknown> {
  switch (request.kind) {
    case "probe":
      return probeWorkerGpu();
    case "device":
      return openDevice();
    case "upload":
      return measure(() => checkedGpu(() => uploads(request.options, request.corrupt)));
    case "image":
      return measure(() => checkedGpu(() => images(request)));
    case "wait":
      return wait(request);
    case "dispose": {
      const current = device;
      device = undefined;
      current?.destroy();
      const lost = current ? await current.lost : undefined;
      return {
        devicesCreated,
        devicesLive: 0,
        buffersLive,
        canvasesLive,
        destroyed: !current || lost?.reason === "destroyed",
      };
    }
  }
}
globalThis.onmessage = (event: MessageEvent<unknown>) => {
  void Promise.resolve()
    .then(() => dispatch(measurementRequest(event.data)))
    .then(
      (value) => globalThis.postMessage({ kind: "reply", value }),
      (error: unknown) => globalThis.postMessage({ kind: "failure", error: String(error) }),
    );
};
globalThis.postMessage({
  kind: "ready",
  realm: "dedicated-worker",
  hasDocument: "document" in globalThis,
  isolated: crossOriginIsolated,
});
