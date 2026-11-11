import type { ResetCode } from "./tcp-byte-channel.js";

export function nativeResetReason(code: ResetCode): { code: ResetCode } {
  return { code };
}

export function nativeResetCode(error: unknown): ResetCode | undefined {
  if (!(error instanceof Error)) return;
  const match = /^(?:Resetstream|StopSending) with code:([1-4])$/.exec(error.message);
  if (!match) return;
  return resetCode(Number(match[1]));
}
function resetCode(value: number): ResetCode | undefined {
  if (value === 1 || value === 2 || value === 3 || value === 4) return value;
}
