import { qualificationRecord as record } from "./qualification-contract.js";
import { desktopObservation } from "./desktop-fairness-observation.js";
import { fairnessConnectionIds } from "./fairness-validation.js";
import { assertRetired, assertTrianglePixels } from "../../gpu-browser-shared.js";
import type { DesktopCaps } from "./desktop-fairness-contract.js";

export function desktopIdentity(value: unknown, token: string, caps: DesktopCaps) {
  const item = record(record(value).identity),
    document = record(item.document);
  if (
    item.token !== token ||
    item.caps !== caps ||
    typeof document.url !== "string" ||
    new URL(document.url).searchParams.get("arm") !== token ||
    typeof document.timeOrigin !== "number" ||
    !Number.isFinite(document.timeOrigin) ||
    document.timeOrigin <= 0 ||
    document.isolated !== true ||
    typeof document.userAgent !== "string" ||
    !document.userAgent
  )
    throw new Error("Wrong desktop arm identity/document");
  return {
    token,
    caps,
    document: {
      url: document.url,
      timeOrigin: document.timeOrigin,
      isolated: true,
      userAgent: document.userAgent,
    },
  };
}
type Identity = ReturnType<typeof desktopIdentity>;
export function desktopResult(value: unknown, expected: Identity) {
  const item = record(value),
    identity = desktopIdentity(value, expected.token, expected.caps);
  if (
    identity.document.url !== expected.document.url ||
    identity.document.timeOrigin !== expected.document.timeOrigin ||
    identity.document.userAgent !== expected.document.userAgent
  )
    throw new Error("Desktop arm changed document");
  return item;
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
export function desktopExit(value: unknown) {
  const item = record(value),
    exit = record(item.exit);
  if (
    exit.kind !== "exited" ||
    exit.code !== 0 ||
    typeof item.text !== "string" ||
    item.text.includes("GPU_FAIL") ||
    !Array.isArray(item.ownAuthority) ||
    !item.ownAuthority.length
  )
    throw new Error("Missing desktop guest exit/own authority report");
  for (const value of item.ownAuthority) {
    const report = record(value);
    if (
      !Array.isArray(report.canaries) ||
      report.canaries.length < 10 ||
      !Array.isArray(report.leaks) ||
      report.leaks.length
    )
      throw new Error("Desktop guest authority control failed");
  }
}
export function desktopControl(value: unknown, identity: Identity) {
  const item = desktopResult(value, identity),
    frame = record(item.frame);
  if (
    !nonnegative(item.firstCompiledFrameMarkerMs) ||
    !String(record(item.incomplete).observerError).includes("positive coverage") ||
    typeof frame.text !== "string" ||
    !frame.text.includes("GPU_FRAME colour=red frame=1 validation=none") ||
    frame.text.includes("GPU_FAIL") ||
    !Array.isArray(frame.errors) ||
    frame.errors.length
  )
    throw new Error("Missing desktop positive/negative control");
}
export function desktopPixels(value: unknown, identity: Identity, colour: string) {
  const pixels = record(desktopResult(value, identity).pixels);
  const rgba = (value: unknown): value is number[] =>
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(
      (byte: unknown) =>
        typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255,
    );
  if (!rgba(pixels.center) || !rgba(pixels.corner)) throw new Error("Malformed desktop pixels");
  assertTrianglePixels({ center: pixels.center, corner: pixels.corner }, colour);
}
export function desktopService(value: unknown, caps: DesktopCaps) {
  const item = record(value);
  for (const key of [
    "connections",
    "devicesLive",
    "heapBytes",
    "frameTexturesLive",
    "presentCanvasesLive",
  ])
    if (!nonnegative(item[key]) || !Number.isSafeInteger(item[key]))
      throw new Error("Malformed desktop service resources");
  if (item.desktopCaps !== caps) throw new Error("Wrong desktop service caps");
  return item;
}
export function desktopArmed(value: unknown, identity: Identity) {
  const item = desktopResult(value, identity);
  desktopExit(item.controlExit);
  const armed = desktopService(item.armed, identity.caps);
  assertRetired(armed);
  const state = desktopObservation(armed),
    coverage = desktopObservation({ fairness: armed.coverage });
  if (
    !Number.isSafeInteger(state.epoch) ||
    state.epoch < 1 ||
    !state.armed ||
    state.overflow ||
    coverage.epoch !== state.epoch - 1 ||
    coverage.armed ||
    coverage.overflow ||
    !coverage.slices.some((slice) => slice.draws > 0) ||
    !coverage.presents.length ||
    !coverage.queue.length ||
    coverage.queue.some((sample) => sample.settlement.kind !== "completed") ||
    !coverage.slices.some((slice) =>
      ["draw", "finish", "submit", "transferToImageBitmap", "transferFromImageBitmap"].every(
        (name) => (coverage.native[`${slice.connection}:${name}`]?.count ?? 0) > 0,
      ),
    )
  )
    throw new Error("Missing desktop native positive coverage/epoch");
  const ready = desktopService(item.ready, identity.caps),
    snapshot = desktopObservation(ready);
  const connections = fairnessConnectionIds(snapshot);
  if (
    snapshot.epoch !== state.epoch ||
    !snapshot.armed ||
    snapshot.overflow ||
    connections.length !== 2 ||
    ready.connections !== 2 ||
    ready.devicesLive !== 2
  )
    throw new Error("Wrong desktop ready cohort/epoch");
  return { epoch: state.epoch, connections };
}
export function desktopFinished(value: unknown, identity: Identity) {
  const item = desktopResult(value, identity);
  desktopService(item, identity.caps);
  if (item.connections !== 1 || item.devicesLive !== 1 || item.frameTexturesLive !== 0)
    throw new Error("Desktop finished resource state differs");
  return desktopObservation(item);
}
export function desktopRetired(value: unknown, identity: Identity) {
  const item = desktopResult(value, identity);
  if (!Array.isArray(item.exits) || item.exits.length !== 2)
    throw new Error("Missing desktop exits");
  for (const exit of item.exits) desktopExit(exit);
  desktopService(item.service, identity.caps);
  assertRetired(item.service);
}
export function desktopCleanup(value: unknown, identity: Identity) {
  const item = desktopResult(value, identity);
  if (
    !Array.isArray(item.errors) ||
    item.errors.length ||
    !Array.isArray(item.workers) ||
    !item.workers.length ||
    !item.workers.every(
      (worker: unknown) =>
        record(worker).stopped === true && typeof record(worker).url === "string",
    )
  )
    throw new Error("Incomplete desktop cleanup");
}
