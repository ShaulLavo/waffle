import { bytes, issuePlatform, type SharedMemoryPlatform } from "./platform.js";
export interface SharedMemoryEnvironment {
  readonly userAgent: string;
  readonly maxTouchPoints: number;
}
// Original Waffle policy, not an upstream implementation. Research and limits:
// https://github.com/YurtOS/yurt-playground/pull/272 (305658a9)
// https://github.com/Automattic/kandelo/pull/1410 (1cf3e9ac), iPadOS UA/touch signal.
// https://github.com/WebKit/WebKit/commit/c40e5ac64afe59b027548e190fc490f12ddf5ea4
// The assumed pool and margin are application policy, never measured device capacity.
const desktop = issuePlatform({ kind: "unbounded", source: "profile", profile: "desktop" });
function appleMobile(match: "ios-user-agent" | "ipados-desktop-user-agent"): SharedMemoryPlatform {
  return issuePlatform({
    kind: "bounded",
    source: "profile",
    profile: "apple-mobile-webkit",
    match,
    assumedPoolBytes: bytes(4 * 1024 ** 3),
    marginBytes: bytes(1024 ** 3),
    budgetBytes: bytes(3 * 1024 ** 3),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: false },
  });
}
const ios = appleMobile("ios-user-agent");
const ipados = appleMobile("ipados-desktop-user-agent");
/** Synchronous selection only. Import and explicit overrides never inspect navigator. */
export function sharedMemoryProfile(
  environment: SharedMemoryEnvironment = globalThis.navigator ?? {
    userAgent: "",
    maxTouchPoints: 0,
  },
): SharedMemoryPlatform {
  const { userAgent, maxTouchPoints } = environment;
  if (!userAgent.includes("AppleWebKit/")) return desktop;
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) return ios;
  if (/\bMacintosh\b/.test(userAgent) && maxTouchPoints > 1) return ipados;
  return desktop;
}
