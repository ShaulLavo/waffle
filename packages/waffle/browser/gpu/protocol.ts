/** Internal G0.1 protocol. No runtime capability or guest import is activated here. */
export const GPU_LIMITS = Object.freeze({
  logicalBytes: 16 * 1024 * 1024,
  serviceBytes: 64 * 1024 * 1024,
  copyBytes: 64 * 1024,
  pending: 64,
  handles: 4096,
  decodeValues: 65536,
});

export const GPU_TERMINAL = Object.freeze({
  closed: 1,
  protocol: 2,
  resource: 3,
  revoked: 4,
  service: 5,
});
export type ConnectionState =
  | { readonly kind: "ready" }
  | {
      readonly kind: "terminal";
      readonly reason: number;
    };

export class GpuProtocolError extends Error {}
export class GpuResourceError extends Error {}
export class GpuCallError extends Error {}

export interface Handle {
  readonly id: number;
  readonly generation: number;
}

export function checkedSpan(size: number, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0)
    throw new GpuProtocolError("Invalid byte span");
  if (offset > size || length > size - offset)
    throw new GpuProtocolError("Byte span exceeds input");
}

/** Ordinary service heap credit, separate from the shared-control allocation ledger. */
export class ServiceCredit {
  #used = 0;
  constructor(readonly limit: number = GPU_LIMITS.serviceBytes) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Invalid heap credit");
  }
  get used(): number {
    return this.#used;
  }
  reserve(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit - this.#used)
      throw new GpuResourceError("GPU service heap credit exhausted");
    this.#used += bytes;
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.#used -= bytes;
    };
  }
}
