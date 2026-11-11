import { ExecutableFormatError } from "../proc/start-errno.js";
import type { SharedLinkPlan } from "./image.js";

const issued = new WeakMap<SharedLinkPlan, WebAssembly.Module>();

/** Page preparation calls this only after every PIE member passed group admission. */
export function issueGroupPlan(image: SharedLinkPlan, core: WebAssembly.Module): void {
  issued.set(image, core);
}

/** Page-only check, before reservations. Clones and adopted records are never issued. */
export function requireGroupPlan(module: WebAssembly.Module, image: unknown): void {
  if (
    !(module instanceof WebAssembly.Module) ||
    !image ||
    typeof image !== "object" ||
    issued.get(image as SharedLinkPlan) !== module
  )
    throw new ExecutableFormatError("memory group requires its page-prepared module/linkPlan pair");
}
