import type { Page } from "playwright";

export async function invoke(page: Page, name: string, args: unknown[] = []) {
  return page.evaluate(
    async ({ name, args }) => {
      const path = "/integration-page.js";
      const module = await import(path);
      return module[name](...args);
    },
    { name, args },
  );
}
export async function pixels(page: Page, slot = 0, waitForRenderingUpdate = true) {
  // ImageBitmap reaches its placeholder at a worker rendering update, not the reply task.
  if (waitForRenderingUpdate) await page.waitForTimeout(100);
  const png = await page.locator(`#triangle-${slot}`).screenshot();
  return page.evaluate(async (bytes) => {
    const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
    const canvas = new OffscreenCanvas(64, 64),
      context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    image.close();
    return {
      center: Array.from(context.getImageData(32, 32, 1, 1).data),
      left: Array.from(context.getImageData(20, 32, 1, 1).data),
      right: Array.from(context.getImageData(44, 32, 1, 1).data),
      corner: Array.from(context.getImageData(1, 1, 1, 1).data),
    };
  }, Array.from(png));
}
export function assertTrianglePixels(
  value: { center: number[]; corner: number[] },
  colour = "red",
  background = [0, 0, 0, 255],
) {
  const expected =
    colour === "green" ? [0, 255, 0, 255] : colour === "blue" ? [0, 0, 255, 255] : [255, 0, 0, 255];
  const close = (actual: number[], wanted: number[]) =>
    actual.length === 4 && actual.every((byte, at) => Math.abs(byte - wanted[at]!) <= 8);
  if (!close(value.center, expected) || !close(value.corner, background))
    throw new Error(`Compiled guest pixel failure: ${JSON.stringify(value)}`);
}
export function assertRetired(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("connections" in value) ||
    value.connections !== 0 ||
    !("devicesLive" in value) ||
    value.devicesLive !== 0 ||
    !("heapBytes" in value) ||
    value.heapBytes !== 0 ||
    !("frameTexturesLive" in value) ||
    value.frameTexturesLive !== 0 ||
    !("presentCanvasesLive" in value) ||
    value.presentCanvasesLive !== 0
  )
    throw new Error(`GPU service retained guest resources: ${JSON.stringify(value)}`);
}
