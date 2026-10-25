import type { PipeEndpointHandle } from "../../proc/pipes.js";

/** Test-only authority inventory. This does not promise raw-view behavior to consumers. */
export function pipePrivateBuffers(...handles: PipeEndpointHandle[]): SharedArrayBuffer[] {
  return handles.flatMap((handle) => {
    const buffer: unknown = Reflect.get(handle, "buffer");
    const lifetime: unknown = Reflect.get(handle, "lifetime");
    const wake: unknown = Reflect.get(handle, "wake");
    if (
      !(buffer instanceof SharedArrayBuffer) ||
      !(lifetime instanceof SharedArrayBuffer) ||
      !(wake instanceof Int32Array) ||
      !(wake.buffer instanceof SharedArrayBuffer)
    )
      throw new Error("pipe private authority fixture shape changed");
    return [buffer, lifetime, wake.buffer];
  });
}
