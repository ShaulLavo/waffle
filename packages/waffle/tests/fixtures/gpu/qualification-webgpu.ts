import { canvasSize } from "./qualification-contract.js";

// TypeScript's DOM declarations include WebGPU interfaces but omit these native constants.
declare const GPUBufferUsage: { COPY_SRC: number; COPY_DST: number; MAP_READ: number };
declare const GPUTextureUsage: { COPY_SRC: number; COPY_DST: number; RENDER_ATTACHMENT: number };
declare const GPUMapMode: { READ: number };

async function waitAsyncProbe(): Promise<boolean> {
  if (typeof Atomics.waitAsync !== "function") return false;
  const cells = new Int32Array(new SharedArrayBuffer(4));
  const wait = Atomics.waitAsync(cells, 0, 0, 1000);
  const timer = setTimeout(() => Atomics.notify(cells, 0), 0);
  try {
    return wait.async && (await wait.value) === "ok";
  } finally {
    clearTimeout(timer);
  }
}

async function sharedUpload(device: GPUDevice): Promise<{ kind: string; detail?: string }> {
  const upload = new Uint32Array(new SharedArrayBuffer(4));
  upload[0] = 0x12345678;
  const source = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  const readback = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  device.pushErrorScope("validation");
  let failure: unknown;
  try {
    device.queue.writeBuffer(source, 0, upload);
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(source, 0, readback, 0, 4);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    if (new Uint32Array(readback.getMappedRange())[0] !== upload[0])
      throw new Error("SAB upload readback differs");
  } catch (error) {
    failure = error;
  } finally {
    readback.destroy();
    source.destroy();
  }
  const validation = await device.popErrorScope();
  if (failure || validation)
    return { kind: "unsupported", detail: String(failure ?? validation?.message) };
  return { kind: "supported" };
}

/** This probes native worker APIs, not Waffle guest acceptance. */
export async function probeWorkerGpu() {
  const common = {
    realm: "dedicated-worker",
    webgpu: Boolean(navigator.gpu),
    offscreenCanvas: typeof OffscreenCanvas === "function",
    bitmaprenderer: Boolean(new OffscreenCanvas(1, 1).getContext("bitmaprenderer")),
    waitAsync: await waitAsyncProbe(),
    sharedArrayBuffer: typeof SharedArrayBuffer === "function" && crossOriginIsolated,
  };
  if (!navigator.gpu)
    return { ...common, adapter: { kind: "missing-webgpu" }, sabUpload: { kind: "not-tested" } };
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter)
    return { ...common, adapter: { kind: "no-adapter" }, sabUpload: { kind: "not-tested" } };
  const device = await adapter.requestDevice();
  try {
    return {
      ...common,
      adapter: {
        kind: "available",
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        description: adapter.info.description,
        device: adapter.info.device,
      },
      sabUpload: await sharedUpload(device),
    };
  } finally {
    device.destroy();
  }
}

function taskTurn(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

const shader = `
@vertex fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let positions = array<vec2f, 3>(vec2f(-0.8, -0.8), vec2f(0.8, -0.8), vec2f(0.0, 0.8));
  return vec4f(positions[i], 0.0, 1.0);
}
@fragment fn fragment() -> @location(0) vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }
`;

async function encodeStableFrame(device: GPUDevice, frame: GPUTexture, format: GPUTextureFormat) {
  const view = frame.createView();
  for (let index = 0; index < 5; index++) await taskTurn();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const module = device.createShaderModule({ code: shader });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vertex" },
    fragment: { module, entryPoint: "fragment", targets: [{ format }] },
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      { view, clearValue: { r: 0, g: 0, b: 1, a: 1 }, loadOp: "clear", storeOp: "store" },
    ],
  });
  pass.setPipeline(pipeline);
  await taskTurn();
  await new Promise((resolve) => setTimeout(resolve, 50));
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
}

function present(
  device: GPUDevice,
  frame: GPUTexture,
  context: ImageBitmapRenderingContext,
  format: GPUTextureFormat,
  suppress: boolean,
) {
  const canvas = new OffscreenCanvas(canvasSize, canvasSize);
  const gpu = canvas.getContext("webgpu");
  if (!(gpu instanceof GPUCanvasContext))
    throw new Error("Standalone worker WebGPU context unavailable");
  gpu.configure({ device, format, usage: GPUTextureUsage.COPY_DST, alphaMode: "opaque" });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToTexture({ texture: frame }, { texture: gpu.getCurrentTexture() }, [
    canvasSize,
    canvasSize,
  ]);
  device.queue.submit([encoder.finish()]);
  frame.destroy();
  const bitmap = canvas.transferToImageBitmap();
  if (suppress) bitmap.close();
  else context.transferFromImageBitmap(bitmap);
  gpu.unconfigure();
}

export async function qualifyStableFrame(context: ImageBitmapRenderingContext, suppress: boolean) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("Stable-frame qualification requires a worker WebGPU adapter");
  const device = await adapter.requestDevice();
  const uncaptured: string[] = [];
  device.addEventListener("uncapturederror", (event) => uncaptured.push(event.error.message));
  const format = navigator.gpu.getPreferredCanvasFormat();
  const frame = device.createTexture({
    size: [canvasSize, canvasSize],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  device.pushErrorScope("validation");
  device.pushErrorScope("out-of-memory");
  device.pushErrorScope("internal");
  try {
    await encodeStableFrame(device, frame, format);
    present(device, frame, context, format, suppress);
    const errors = await Promise.all([
      device.popErrorScope(),
      device.popErrorScope(),
      device.popErrorScope(),
    ]);
    if (errors.some(Boolean))
      throw new Error(
        `Stable-frame error scope: ${errors.map((error) => error?.message).join("; ")}`,
      );
    device.destroy();
    const lost = await device.lost;
    await taskTurn();
    if (uncaptured.length) throw new Error(`Uncaptured GPU errors: ${uncaptured.join("; ")}`);
    return {
      kind: "stable-frame",
      taskTurns: 6,
      openPassPauseMs: 50,
      deviceDestroyed: lost.reason === "destroyed",
      errors: [],
      uncaptured,
      suppressed: suppress,
    };
  } finally {
    frame.destroy();
    device.destroy();
  }
}
