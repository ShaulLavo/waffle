import { isAbsolute } from "node:path";
import { record } from "./protocol.js";
import type { FrameworkOptions, Json, SafariReturned, VitestEnd } from "./framework-types.js";

export function jsonValue(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return record(value) && Object.values(value).every(jsonValue);
}
export function parseCapabilities(value: unknown, udid: string): SafariReturned {
  if (
    !record(value) ||
    !jsonValue(value) ||
    value.browserName !== "Safari" ||
    value.platformName !== "iOS" ||
    value["safari:useSimulator"] !== true ||
    value["safari:deviceUDID"] !== udid ||
    typeof value.browserVersion !== "string" ||
    !value.browserVersion
  )
    throw new Error("Invalid returned Safari/iOS/Simulator/UDID capabilities");
  // The checked map is retained, including all actual extension capabilities.
  return value as SafariReturned;
}
export function validateFrameworkOptions(options: FrameworkOptions): void {
  if (!options.suite || !options.native.udid || !isAbsolute(options.resultPath))
    throw new Error("Invalid framework host options");
  if (
    options.scope.kind !== "root-selection" ||
    options.scope.command !== "test:browser" ||
    options.scope.files.length !== 1
  )
    throw new Error("Framework host requires one root-command selection");
  const file = options.scope.files[0];
  const identities = new Set<string>();
  if (!options.expected.length) throw new Error("Independent expected inventory is required");
  for (const item of options.expected) {
    if (
      item.file !== file ||
      !item.fullName ||
      !item.sourceKey ||
      item.timeoutMs !== 15000 ||
      item.retries !== 0
    )
      throw new Error("Invalid expected case identity or original clock");
    const key = `${item.file}\n${item.fullName}`;
    if (identities.has(key)) throw new Error("Duplicate expected identity");
    identities.add(key);
  }
}

export function parseVitestEnd(value: unknown): VitestEnd {
  if (!record(value)) throw new Error("Missing actual Vitest end status");
  if (value.status === "passed") return { status: "passed" };
  if (
    (value.status === "failed" || value.status === "interrupted") &&
    Array.isArray(value.errors) &&
    value.errors.every(jsonValue)
  )
    return { status: value.status, errors: value.errors };
  throw new Error("Invalid actual Vitest end status");
}
