import type { DriverObservationBinding } from "./driver.js";
import { record } from "./protocol.js";

/** Classes only: observation URLs and markers contain private document tokens. */
export function bootstrapURLClass(value: unknown, binding: DriverObservationBinding): string {
  if (typeof value !== "string") return "unavailable";
  if (!value) return "empty";
  if (value === binding.bootstrapURL) return "bootstrap";
  if (value === binding.expectedURL) return "expected-page";
  if (value === "about:blank") return "about:blank";
  try {
    if (new URL(value).origin === new URL(binding.bootstrapURL).origin) return "same-origin-other";
  } catch {}
  return "other";
}

export function bootstrapIdentityClasses(
  value: unknown,
  binding: DriverObservationBinding,
): string {
  let identity: unknown;
  try {
    identity = typeof value === "string" ? JSON.parse(value) : undefined;
  } catch {}
  const url = record(identity) ? identity.url : undefined;
  const marker = record(identity) ? identity.marker : undefined;
  const expected = new URL(binding.bootstrapURL).searchParams.get("token");
  const markerClass =
    marker === null || marker === undefined
      ? "absent"
      : marker === expected
        ? "present"
        : "different";
  return `url=${bootstrapURLClass(url, binding)} marker=${markerClass}`;
}
