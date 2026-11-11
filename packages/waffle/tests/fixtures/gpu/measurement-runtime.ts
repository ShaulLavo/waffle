import {
  openIntegration,
  activateDisplay,
  launchTriangle,
  drainTriangle,
  stopTriangle,
  closeIntegration,
  pressure,
  serviceCommand,
} from "./integration-page.js";

let opened = false;
/** @browserEntry */
export async function startMeasuredTriangle(timeoutMs: number) {
  const start = performance.now();
  opened = true;
  await openIntegration();
  await activateDisplay();
  await launchTriangle();
  while (performance.now() - start < timeoutMs) {
    const value = drainTriangle();
    if (value.errors.length || value.text.includes("GPU_FAIL"))
      throw new Error(`Compiled triangle failed: ${value.text} ${value.errors.join("; ")}`);
    if (value.text.includes("GPU_FRAME"))
      return {
        firstFrameMarkerMs: performance.now() - start,
        evidence: value,
        source: "Unmodified compiled blocking WASI triangle through real runtime imports",
      };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Compiled triangle first-frame deadline");
}
/** @browserEntry */
export async function stopMeasuredTriangle() {
  return stopTriangle(true);
}
/** @browserEntry */
export async function pressureMeasuredTriangle() {
  return { page: pressure(), service: await serviceCommand("pressure") };
}
/** @browserEntry */
export async function closeMeasuredTriangle() {
  if (!opened) return;
  opened = false;
  return closeIntegration();
}
/** @browserEntry */
export async function observeTriangleScreenshot(base64: string, slot = 0, colour = "red") {
  const canvas = document.querySelector(`#triangle-${slot}`);
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Triangle canvas missing");
  const image = new Image();
  image.src = `data:image/png;base64,${base64}`;
  await image.decode();
  const observed = new OffscreenCanvas(image.width, image.height);
  const context = observed.getContext("2d");
  if (!context) throw new Error("Screenshot decoder unavailable");
  context.drawImage(image, 0, 0);
  const rect = canvas.getBoundingClientRect();
  const sx = image.width / innerWidth,
    sy = image.height / innerHeight;
  const pixel = (x: number, y: number) =>
    Array.from(
      context.getImageData(Math.floor((rect.x + x) * sx), Math.floor((rect.y + y) * sy), 1, 1).data,
    );
  const center = pixel(32, 32),
    corner = pixel(1, 1);
  if (
    center[0]! < (colour === "red" ? 247 : 0) ||
    center[0]! > (colour === "red" ? 255 : 8) ||
    center[1]! < (colour === "green" ? 247 : 0) ||
    center[1]! > (colour === "green" ? 255 : 8) ||
    center[2]! > 8 ||
    center[3]! < 247 ||
    corner.slice(0, 3).some((byte) => byte > 8) ||
    corner[3]! < 247
  )
    throw new Error(
      `Compiled triangle screenshot oracle failed: ${JSON.stringify({ center, corner })}`,
    );
  return { center, corner };
}
