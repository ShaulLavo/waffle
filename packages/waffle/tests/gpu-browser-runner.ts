import { gpuPayloadLayout } from "../browser/display/generated/graphics-layout.js";
import { navigateTestPage } from "./browser-navigation.js";
import { verifiedGpuFixture, verifiedGpuSceneFixture } from "../scripts/build-gpu-fixture.js";
import { gpuLazyRoutes, assertGpuLazyBrowser } from "./gpu-loading-browser.js";
import { resolve } from "node:path";
import {
  GpuQualificationLifecycle,
  qualificationEngine,
  requireWorkerAdapter,
  qualifyGpuBrowser,
  qualificationRoutes,
} from "./gpu-browser-qualification.js";
import { browserBundle } from "./browser-runner-lifecycle.js";
import { malformedCases } from "./gpu-malformed-browser.js";
import { ownershipCases } from "./gpu-ownership-browser.js";
import { fairnessCases } from "./gpu-fairness-browser.js";
import { invoke, pixels, assertTrianglePixels, assertRetired } from "./gpu-browser-shared.js";
import type { Page } from "playwright";

const fixture = resolve(process.env.GPU_FIXTURE_DIR ?? ".build/gpu-fixture", "triangle.wasm");
async function marker(page: Page, text: string, slot = 0) {
  const deadline = Date.now() + 20000;
  let observed: unknown;
  while (Date.now() < deadline) {
    const value = await invoke(page, "drainTriangle", [slot, false]);
    observed = value;
    if (value.text.includes(text)) return;
    if (value.errors.length)
      throw new Error(`Guest failed before ${text}: ${JSON.stringify(value.errors)}`);
    if (value.text.includes("GPU_FAIL"))
      throw new Error(`Guest failed before ${text}: ${value.text}`);
    await page.waitForTimeout(20);
  }
  throw new Error(`Guest marker deadline ${text}: ${JSON.stringify(observed)}`);
}
async function guestCase(page: Page, suppress = false) {
  await invoke(page, "openIntegration", [suppress]);
  const lazy = await invoke(page, "activateDisplay");
  try {
    await invoke(page, "launchTriangle", [["--split", "--pause-acquired"]]);
    await marker(page, "GPU_WAIT_STDIN stage=acquired");
    const paused = await invoke(page, "drainTriangle");
    // Real compiled guests on a second connection present while A holds its stable texture.
    for (let index = 0; index < 5; index++) {
      await invoke(page, "launchTriangle", [["green"], "gpu", 1]);
      await marker(page, "GPU_FRAME", 1);
      if (!suppress) {
        const output = await invoke(page, "drainTriangle", [1]);
        console.log(
          JSON.stringify({
            stage: "second-connection-frame",
            index,
            text: output.text,
            service: output.service,
          }),
        );
        assertTrianglePixels(await pixels(page, 1), "green");
      }
      await invoke(page, "stopTriangle", [false, 1]);
    }
    await invoke(page, "feedTriangle");
    await marker(page, "GPU_FRAME");
    const before = await invoke(page, "drainTriangle");
    if (before.service.slices - paused.service.slices < 10 || before.service.presents < 6)
      throw new Error("Split frame did not span real service turns and five other presentations");
    if (
      before.errors.length ||
      before.workers.filter((worker: { url: string }) =>
        worker.url.includes("/gpu/service-worker.ts"),
      ).length !== 1
    )
      throw new Error("GPU activation/lifecycle isolation failed");
    let rejected = false;
    try {
      assertTrianglePixels(await pixels(page));
    } catch {
      rejected = true;
    }
    if (rejected !== suppress)
      throw new Error(`Compiled guest transfer control differs, suppressed=${suppress}`);
    const stopped = await invoke(page, "stopTriangle", [true]);
    assertRetired(stopped.service);
    if (stopped.exit.kind !== "signaled" || stopped.exit.code !== 9)
      throw new Error("Kill did not select SIGKILL");
    assertControlAccounting(stopped.snapshot);
    if (!suppress) await retainedPixels(page, "red");
    // The transferred visible canvas is reused, rather than allocating a replacement element.
    await invoke(page, "launchTriangle", [["green", "--pause-acquired"], "gpu", 0, true]);
    await marker(page, "GPU_WAIT_STDIN stage=acquired");
    if (!suppress) assertTrianglePixels(await pixels(page));
    const midFrame = await invoke(page, "stopTriangle", [true]);
    assertRetired(midFrame.service);
    if (!suppress) await retainedPixels(page, "red");
    await invoke(page, "launchTriangle", [["green"], "gpu", 0, true]);
    await marker(page, "GPU_FRAME");
    if (!suppress) assertTrianglePixels(await pixels(page), "green");
    const reused = await invoke(page, "stopTriangle");
    assertRetired(reused.service);
    if (reused.exit.kind !== "exited" || reused.exit.code !== 0)
      throw new Error(`Ordinary close failed: ${reused.text}`);
    if (!suppress) await retainedPixels(page, "green");
    if (
      !reused.authority.length ||
      reused.authority.some(
        (report: { canaries: string[]; leaks: string[] }) =>
          report.canaries.length < 10 || report.leaks.length,
      )
    )
      throw new Error("GPU authority canaries failed");
    return {
      lazy,
      paused,
      before,
      stopped,
      retained: !suppress,
      suppressedPixelGateRejected: rejected,
      reused,
      midFrame,
    };
  } finally {
    await invoke(page, "closeIntegration");
  }
}
type SceneMode = "normal" | "no-depth" | "black-texture";
/** Both texture columns must survive sampling, dynamic binding and indexed depth ordering. */
export function assertScenePixels(
  value: { left: number[]; right: number[]; corner: number[] },
  mode: SceneMode = "normal",
) {
  const colour = mode === "no-depth" ? 1 : 0;
  const left = [0, 0, 0, 255],
    right = [0, 0, 0, 255];
  if (mode !== "black-texture") {
    left[colour] = 255;
    right[colour] = 128;
  }
  const close = (actual: number[], expected: number[]) =>
    actual.length === 4 && actual.every((byte, at) => Math.abs(byte - expected[at]!) <= 8);
  if (
    !close(value.left, left) ||
    !close(value.right, right) ||
    !close(value.corner, [0, 0, 255, 255])
  )
    throw new Error(`Compiled scene pixel failure, mode=${mode}: ${JSON.stringify(value)}`);
}
async function sceneCase(page: Page, mode: SceneMode) {
  // Keep unsolicited telemetry stale so only a correlated snapshot can prove this checkpoint.
  await invoke(page, "openIntegration", [false, "", true]);
  await invoke(page, "activateDisplay");
  try {
    await invoke(page, "launchScene", [mode === "normal" ? [] : [`--${mode}`]]);
    await marker(page, "GPU_WAIT_STDIN stage=scene-encoded");
    const encoded = await invoke(page, "drainTriangle");
    encoded.service = await invoke(page, "serviceCommand", ["snapshot"]);
    if (
      !encoded.text.includes("GPU_SCENE_RELEASED ordinary=13 frame=retained stage=before-submit") ||
      encoded.service.presents !== 0 ||
      encoded.service.frameTexturesLive !== 1
    )
      throw new Error(
        `Scene did not pause after ordinary handle release: ${JSON.stringify(encoded)}`,
      );
    await invoke(page, "feedTriangle");
    await marker(page, `GPU_SCENE_FRAME mode=${mode}`);
    const image = await pixels(page);
    assertScenePixels(image, mode);
    if (mode !== "normal") {
      let rejected = false;
      try {
        assertScenePixels(image);
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error(`Scene negative control ${mode} passed positive pixels`);
    }
    const stopped = await invoke(page, "stopTriangle");
    assertRetired(stopped.service);
    assertControlAccounting(stopped.snapshot);
    if (
      stopped.exit.kind !== "exited" ||
      stopped.exit.code !== 0 ||
      stopped.text.includes("GPU_FAIL")
    )
      throw new Error(`Compiled scene failed: ${JSON.stringify(stopped)}`);
    if (
      !stopped.authority.length ||
      stopped.authority.some(
        (report: { canaries: string[]; leaks: string[] }) =>
          report.canaries.length < 10 || report.leaks.length,
      )
    )
      throw new Error("Compiled scene authority canaries failed");
    return { compiledGuest: true, mode, image, encoded, stopped };
  } finally {
    await invoke(page, "closeIntegration");
  }
}
async function sceneCases(page: Page, url: string, available: boolean) {
  if (!available) return [await unsupportedCase(page, "gpu", true)];
  const results = [];
  for (const mode of ["normal", "no-depth", "black-texture"] satisfies SceneMode[]) {
    await navigateTestPage(page, url);
    results.push(await sceneCase(page, mode));
  }
  return results;
}
async function retainedPixels(page: Page, colour: string) {
  for (const ms of [500, 2500, 7000]) {
    await page.waitForTimeout(ms);
    await invoke(page, "pressure");
    await invoke(page, "serviceCommand", ["pressure"]);
    assertTrianglePixels(await pixels(page), colour);
  }
}

async function unsupportedCase(page: Page, grant: "gpu" | "surface" | "none", scene = false) {
  await invoke(page, "openIntegration");
  await invoke(page, "activateDisplay");
  try {
    await invoke(page, scene ? "launchScene" : "launchTriangle", [[], grant]);
    const result = await invoke(page, "stopTriangle", [false, 0, false]);
    if (result.exit.kind === "exited" && result.exit.code === 0)
      throw new Error("Unsupported/absent GPU unexpectedly succeeded");
    if (
      grant === "gpu" &&
      (result.exit.kind !== "exited" || result.exit.code !== 1 || !result.text.includes("GPU_FAIL"))
    )
      throw new Error(
        `Unsupported native path did not report its real guest failure: ${JSON.stringify(result.exit)} ${result.text}`,
      );
    if (result.text.includes("GPU_FRAME")) throw new Error("Unsupported guest drew a frame");
    return result;
  } finally {
    await invoke(page, "closeIntegration");
  }
}

async function forgedCase(page: Page) {
  await invoke(page, "openIntegration");
  await invoke(page, "activateDisplay");
  try {
    await invoke(page, "launchTriangle", [[], "gpu", 0, false, true]);
    const failed = await invoke(page, "stopTriangle", [false, 0, false]);
    if (!failed.text.includes("GPU_FAIL") || failed.text.includes("GPU_FRAME"))
      throw new Error(
        `Forged surface did not fail: ${JSON.stringify({ exit: failed.exit, text: failed.text, errors: (await invoke(page, "drainTriangle")).errors })}`,
      );
    await invoke(page, "launchTriangle", [["green"], "gpu", 1]);
    await marker(page, "GPU_FRAME", 1);
    assertTrianglePixels(await pixels(page, 1), "green");
    const survivor = await invoke(page, "stopTriangle", [false, 1]);
    assertRetired(survivor.service);
    return { failed, survivor };
  } finally {
    await invoke(page, "closeIntegration");
  }
}

async function frameModes(page: Page) {
  await invoke(page, "openIntegration");
  await invoke(page, "activateDisplay");
  try {
    await invoke(page, "launchTriangle", [["red", "--repeat-acquire"]]);
    await marker(page, "GPU_REPEATED_ACQUIRE first=8 second=13");
    await marker(page, "GPU_FRAME");
    assertTrianglePixels(await pixels(page), "red", [0, 255, 0, 255]);
    const repeated = await invoke(page, "serviceCommand", ["snapshot"]);
    if (repeated.frameTexturesCreated !== 1 || repeated.presents !== 1)
      throw new Error("Repeated acquire did not alias one ordinary native texture");
    const repeatedExit = await invoke(page, "stopTriangle");
    assertRetired(repeatedExit.service);
    await invoke(page, "launchTriangle", [
      ["red", "--discard-after-first-frame", "--expired-frame-use"],
    ]);
    await marker(page, "GPU_WAIT_STDIN stage=discarded");
    assertTrianglePixels(await pixels(page));
    const discarded = await invoke(page, "serviceCommand", ["snapshot"]);
    if (discarded.frameTexturesLive !== 0)
      throw new Error("Discarded frame retained a native texture");
    await invoke(page, "feedTriangle", ["x"]);
    await marker(page, "GPU_FRAME colour=transparent frame=3 validation=none");
    await marker(page, "GPU_EXPECTED_VALIDATION stage=expired-frame texture=40 type=2");
    await marker(page, "GPU_STAGE after-expired-validation connection=ready");
    const transparent = [];
    for (const colour of ["rgb(255, 0, 255)", "rgb(0, 255, 255)"]) {
      await invoke(page, "canvasBackground", [colour]);
      const image = await pixels(page);
      const expected = colour.includes("255, 0, 255") ? [255, 0, 255, 255] : [0, 255, 255, 255];
      if (
        !image.center.every((value, at) => value === expected[at]) ||
        !image.corner.every((value, at) => value === expected[at])
      )
        throw new Error(`Fresh frame is not transparent: ${JSON.stringify(image)}`);
      transparent.push(image);
    }
    const expired = await invoke(page, "stopTriangle");
    assertRetired(expired.service);
    if (expired.exit.kind !== "exited" || expired.exit.code !== 0)
      throw new Error(`Discard/expired native fixture failed: ${expired.text}`);
    return { repeated, repeatedExit, discarded, transparent, expired };
  } finally {
    await invoke(page, "closeIntegration");
  }
}

async function heldKillCase(page: Page, hold: "open" | "adapter" | "device") {
  await invoke(page, "openIntegration", [false, hold]);
  await invoke(page, "activateDisplay");
  try {
    await invoke(page, "launchTriangle");
    const deadline = Date.now() + 15000;
    let before;
    while (Date.now() < deadline) {
      before = await invoke(page, "serviceCommand", ["snapshot"]);
      if (before?.held === hold) break;
      await page.waitForTimeout(20);
    }
    if (before?.held !== hold) throw new Error(`Native ${hold} control did not arm`);
    const stopped = await invoke(page, "stopTriangle", [true]);
    assertRetired(stopped.service);
    await invoke(page, "serviceCommand", ["release"]);
    await page.waitForTimeout(100);
    const after = await invoke(page, "serviceCommand", ["snapshot"]);
    assertRetired(after);
    if (hold === "device" && (after.lateCreated !== 1 || after.lateDestroyed !== 1))
      throw new Error("Late native device survived revoked owner");
    if (hold === "open") {
      await invoke(page, "launchTriangle", [["green"]]);
      await marker(page, "GPU_FRAME");
      assertTrianglePixels(await pixels(page), "green");
      await invoke(page, "stopTriangle");
    }
    return { before, stopped, after };
  } finally {
    await invoke(page, "closeIntegration");
  }
}

export function assertControlAccounting(snapshot: {
  platform: { kind: string };
  holders: { label: string; state: string; shape: { kind: string; length?: number } }[];
}) {
  const controls = snapshot.holders.filter((holder) => holder.label === "guest-control");
  if (snapshot.platform.kind !== "bounded" || !controls.length)
    throw new Error("Actual bounded control snapshot missing");
  const live = controls.filter((holder) => holder.state === "live");
  // The adopted page root remains live; its original 64 MiB grant is not a guest leak.
  if (live.length !== 1 || live[0]?.shape.length !== 64 * 1024 * 1024)
    throw new Error(`Unexpected live control owners: ${JSON.stringify(controls)}`);
  if (
    controls
      .filter((holder) => holder.state !== "live")
      .some((holder) => holder.state !== "debt" && holder.state !== "awaiting-collection")
  )
    throw new Error("Invalid retired control state");
  if (
    !controls.some(
      (holder) =>
        holder.shape.kind === "fixed-buffer" &&
        holder.shape.length === 4 * 1024 * 1024 + 256 * 1024 + 196 + gpuPayloadLayout.byteLength,
    )
  )
    throw new Error(`GPU fixed backing charge missing: ${JSON.stringify(controls)}`);
}

/** The CI lane requires the designated software adapter, not a silent hardware fallback. */
export function requireIntegrationAdapter(
  engine: "chromium" | "firefox" | "webkit",
  capabilities: Record<string, unknown>,
): boolean {
  const available = requireWorkerAdapter(engine, capabilities);
  if (engine !== "chromium") return available;
  const adapter = capabilities.adapter;
  if (
    typeof adapter !== "object" ||
    adapter === null ||
    !("architecture" in adapter) ||
    adapter.architecture !== "swiftshader"
  )
    throw new Error(`Required Chromium SwiftShader adapter missing: ${JSON.stringify(adapter)}`);
  return available;
}

async function main() {
  const runner = new GpuQualificationLifecycle();
  try {
    await runner.init(process.env.GPU_SCRATCH_ROOT ?? "/work/tmp");
    const lazy = await gpuLazyRoutes();
    const routes = { ...(await qualificationRoutes()), ...lazy.routes };
    routes["/integration-page.js"] = await browserBundle(
      new URL("./fixtures/gpu/integration-page.ts", import.meta.url).pathname,
    );
    routes["/gpu-guest.js"] = await browserBundle(
      new URL("./fixtures/gpu/integration-guest.ts", import.meta.url).pathname,
    );
    routes["/gpu/service-worker.ts"] = await browserBundle(
      new URL("./fixtures/gpu/integration-service-worker.ts", import.meta.url).pathname,
    );
    routes["/gpu/service-worker.ts/ownership"] = await browserBundle(
      new URL("./fixtures/gpu/ownership-service-worker.ts", import.meta.url).pathname,
    );
    routes["/fs-worker.js"] = await browserBundle(
      new URL("../browser/fs-worker.ts", import.meta.url).pathname,
    );
    routes["/triangle.wasm"] = new Blob([verifiedGpuFixture(resolve(fixture, ".."))], {
      type: "application/wasm",
    });
    routes["/scene.wasm"] = new Blob([verifiedGpuSceneFixture(resolve(fixture, ".."))], {
      type: "application/wasm",
    });
    const url = runner.serve(routes);
    for (const requested of process.argv.slice(2).length
      ? process.argv.slice(2)
      : ["chromium", "firefox", "webkit"]) {
      const engine = qualificationEngine(requested),
        browser = await runner.launch(engine);
      const context = await browser.newContext({ viewport: { width: 320, height: 240 } }),
        page = await context.newPage();
      page.on("pageerror", (error) => console.error(error));
      const loading = await assertGpuLazyBrowser(page, url, lazy.outputInputs);
      await navigateTestPage(page, url);
      const qualification = await qualifyGpuBrowser(page, engine);
      const available = requireIntegrationAdapter(engine, qualification.capabilities);
      const malformed = await malformedCases(page, url, available);
      console.log(JSON.stringify({ engine, stage: "malformed", malformed }));
      const ownership = await ownershipCases(page, url, available);
      console.log(JSON.stringify({ engine, stage: "ownership", ownership }));
      const fairness = await fairnessCases(page, url, available);
      console.log(JSON.stringify({ engine, stage: "fairness", fairness }));
      const scenes = await sceneCases(page, url, available);
      await navigateTestPage(page, url);
      const guest = available ? await guestCase(page) : await unsupportedCase(page, "gpu");
      await navigateTestPage(page, url);
      const negative = available ? await guestCase(page, true) : undefined;
      const held = available
        ? await Promise.resolve().then(async () => {
            const results = [];
            for (const mode of ["open", "adapter", "device"] as const) {
              await navigateTestPage(page, url);
              results.push(await heldKillCase(page, mode));
            }
            return results;
          })
        : undefined;
      await navigateTestPage(page, url);
      const frames = available ? await frameModes(page) : undefined;
      await navigateTestPage(page, url);
      const forged = available ? await forgedCase(page) : undefined;
      await navigateTestPage(page, url);
      const noGrant = await unsupportedCase(page, "none");
      await navigateTestPage(page, url);
      const surfaceOnly = await unsupportedCase(page, "surface");
      console.log(
        JSON.stringify({
          engine,
          loading,
          qualification,
          ownership,
          guest,
          scenes,
          fairness,
          negative,
          held,
          forged,
          frames,
          noGrant,
          surfaceOnly,
        }),
      );
      await context.close();
      await runner.closeBrowser(browser);
    }
  } finally {
    await runner.close();
  }
}
if (import.meta.main) await main();
