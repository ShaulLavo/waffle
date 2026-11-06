import {
  canvasSize,
  pressureBurst,
  qualificationRecord,
  type QualificationRequest,
} from "./qualification-contract.js";

let worker: Worker | undefined;
let canvas: HTMLCanvasElement | undefined;

function request(message: QualificationRequest, transfer: Transferable[] = []): Promise<unknown> {
  const target = worker;
  if (!target) throw new Error("Qualification worker is not running");
  return new Promise((resolve, reject) => {
    const clear = () => {
      clearTimeout(timer);
      target.onmessage = null;
      target.onerror = null;
    };
    const timer = setTimeout(() => {
      clear();
      reject(new Error(`Qualification worker deadline: ${message.kind}`));
    }, 15_000);
    target.onerror = (event) => {
      clear();
      reject(new Error(event.message));
    };
    target.onmessage = (event: MessageEvent<unknown>) => {
      clear();
      const reply = qualificationRecord(event.data);
      if (reply.kind === "reply") resolve(reply.value);
      else reject(new Error(String(reply.error)));
    };
    target.postMessage(message, transfer);
  });
}

/** @browserEntry */
export async function openQualification(): Promise<unknown> {
  if (worker) throw new Error("Qualification worker already open");
  document.body.style.margin = "0";
  canvas = document.createElement("canvas");
  canvas.width = canvasSize;
  canvas.height = canvasSize;
  document.body.append(canvas);
  worker = new Worker("/qualification-worker.js", { type: "module" });
  const control = new SharedArrayBuffer(4);
  const offscreen = canvas.transferControlToOffscreen();
  const response = await request({ kind: "attach", canvas: offscreen, control }, [offscreen]);
  if (Atomics.load(new Int32Array(control), 0) !== 1)
    throw new Error("Worker did not mutate the shared realm canary");
  return { response, sharedCanary: 1, isolated: crossOriginIsolated };
}

/** @browserEntry */
export async function qualificationCommand(message: QualificationRequest): Promise<unknown> {
  if (message.kind === "pressure") pressureBurst();
  return request(message);
}

/** @browserEntry */
export function closeQualification(): void {
  worker?.terminate();
  worker = undefined;
  canvas?.remove();
  canvas = undefined;
}
