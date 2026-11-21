import { SharedFilesystemState } from "../fs/shared.js";

globalThis.onmessage = (
  event: MessageEvent<{ buffer: SharedArrayBuffer; handle: number; epoch: Int32Array }>,
) => {
  const { buffer, handle, epoch } = event.data;
  const state = new SharedFilesystemState(buffer, undefined, 178);
  state.experimentAfterFirstCopy = () => {
    globalThis.postMessage("copied bytes under lock");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
  const slot = state.fileSlot(handle);
  state.directWrite(slot, handle, [new Uint8Array([99])], 0, 1, epoch, () => false, 178);
};
