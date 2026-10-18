import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as native from "../../proc/intrinsics.ts";
import { ProcessError } from "../../proc/types.js";
import type * as Pipes from "../../proc/pipes.js";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
  readFileSync(new URL("../../proc/pipes.ts", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, "")
    .concat(
      "\nglobalThis.pipeExports = { attachPipeController, attachPipeEndpoint, attachPipePublicationRegistry, PipeController, PipeEndpoint, PipeErrno, PipePublicationRegistry };\n",
    ),
);

/**
 * Evaluate the actual pipes implementation with test-owned forwarding imports.
 * Production imports remain untouched, and neither globals nor the module cache
 * are mocked. Tests can interleave at captured-operation boundaries instead of
 * depending on guest replacements reaching private state after module capture.
 */
export function isolatedPipes() {
  const atomics = Object.create(Atomics) as typeof Atomics;
  const hooks = {
    SharedArrayBufferConstructor: native.SharedArrayBufferConstructor,
    sharedArrayBufferGrow: native.sharedArrayBufferGrow,
    typedArraySubarray: native.typedArraySubarray,
  };
  const captured: Record<string, unknown> = { ...native };
  for (const key of Object.keys(native)) {
    if (!key.startsWith("atomics")) continue;
    const method = key.slice("atomics".length);
    const name = method[0]!.toLowerCase() + method.slice(1);
    captured[key] = (...args: unknown[]) =>
      Reflect.apply(Reflect.get(atomics, name), atomics, args);
  }
  captured.SharedArrayBufferConstructor = new Proxy(native.SharedArrayBufferConstructor, {
    construct(_target, args, newTarget) {
      return Reflect.construct(hooks.SharedArrayBufferConstructor, args, newTarget);
    },
  });
  captured.sharedArrayBufferGrow = (buffer: SharedArrayBuffer, length: number) =>
    hooks.sharedArrayBufferGrow(buffer, length);
  captured.typedArraySubarray = (view: Uint8Array, begin?: number, end?: number) =>
    hooks.typedArraySubarray(view, begin, end);
  const context = {
    ...captured,
    ProcessError,
    Error,
    RangeError,
    TypeError,
    crypto,
    console,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    pipeExports: undefined as unknown as typeof Pipes,
  };
  runInNewContext(source, context, {
    filename: new URL("../../proc/pipes.ts", import.meta.url).pathname,
  });
  return { pipes: context.pipeExports, atomics, hooks };
}
