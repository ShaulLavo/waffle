import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { nativeRelease } from "../container/native/release.ts";

export const imageRepository = "ghcr.io/shaullavo/waffle-relay";
export const localImage = "waffle-relay:validated";
export const platform = "linux/amd64";
export const root = resolve(import.meta.dirname, "../../..");

export function variant(value: string) {
  assert.ok(value === "ws" || value === "native", "Expected fixed ws or native image variant");
  return value;
}
export function hash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function specification(value: string) {
  const selected = variant(value);
  const template = `packages/waffle-relay/container${selected === "native" ? "/native" : ""}`;
  const fileHash = (file: string) => hash(readFileSync(resolve(root, template, file)));
  return {
    variant: selected,
    platform,
    source:
      selected === "native" ? nativeRelease.source : "5f3d329f35be618e5b4d822c0ee933bbfd9a10f5",
    version: selected === "native" ? nativeRelease.version : "0.0.109",
    release: selected === "native" ? nativeRelease : null,
    template,
    dockerfileSha256: fileHash("Dockerfile"),
    configSha256: fileHash("relay.json"),
    lockSha256: fileHash("package-lock.json"),
  };
}
export function publicationContext(env: NodeJS.ProcessEnv) {
  const selected = variant(env.IMAGE_VARIANT ?? "");
  const sourceHead = env.GITHUB_SHA ?? "";
  const runId = env.GITHUB_RUN_ID ?? "";
  const runAttempt = env.GITHUB_RUN_ATTEMPT ?? "";
  assert.match(sourceHead, /^[0-9a-f]{40}$/, "Expected exact workflow source");
  assert.match(runId, /^[1-9][0-9]*$/, "Expected workflow run ID");
  assert.match(runAttempt, /^[1-9][0-9]*$/, "Expected workflow attempt");
  return { sourceHead, runId, runAttempt, specification: specification(selected) };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "Expected object");
  return value;
}
export function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "Expected array");
  return value;
}
