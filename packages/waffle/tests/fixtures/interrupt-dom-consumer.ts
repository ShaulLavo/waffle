import { InterruptModuleCache, rewriteInterrupts } from "waffle/interrupt";

const shared = new Uint8Array(new SharedArrayBuffer(16));
shared.set([0, 97, 115, 109, 1, 0, 0, 0], 4);
const view = shared.subarray(4, 12);
const rewritten: Uint8Array<ArrayBuffer> = rewriteInterrupts(view);
WebAssembly.validate(rewritten);
void WebAssembly.compile(rewritten);
void new InterruptModuleCache().compile(view);
