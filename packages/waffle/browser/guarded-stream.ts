import {
  objectCreate,
  objectGetPrototypeOf,
  reflectGet,
  reflectSet,
  reflectApply,
  ProxyConstructor,
  MapConstructor,
  mapHas,
  mapGet,
  mapSet,
} from "../proc/intrinsics.ts";
import type { Stream } from "../core/descriptors.js";

/** Preserve endpoint prototypes, private receivers and optional immediate I/O while guarding
 * every admission operation. Cleanup remains available after logical death. */
export function guardedStream(
  stream: Stream,
  checkActive: () => void,
  owned?: (stream: Stream) => void,
): Stream {
  const methods = new MapConstructor<PropertyKey, unknown>();
  // Keep instanceof identity without proxying frozen own properties: wrapped methods must
  // differ from their originals, which a non-configurable target property would forbid.
  const target: Stream = objectCreate(objectGetPrototypeOf(stream));
  const handler: ProxyHandler<Stream> & { __proto__: null } = {
    __proto__: null,
    set(target, key, value, receiver) {
      if (key !== "fdflags") return reflectSet(target, key, value, receiver);
      checkActive();
      return reflectSet(stream, key, value, stream);
    },
    get(_target, key) {
      const value = reflectGet(stream, key, stream);
      if (typeof value !== "function") return value;
      if (mapHas(methods, key)) return mapGet(methods, key);
      const method =
        key === "forProcess"
          ? (pid: number) => {
              checkActive();
              return guardedStream(reflectApply(value, stream, [pid]), checkActive, owned);
            }
          : key === "read" ||
              key === "write" ||
              key === "tryRead" ||
              key === "tryWrite" ||
              key === "readiness" ||
              key === "recv" ||
              key === "shutdown"
            ? (...args: unknown[]) => {
                checkActive();
                return reflectApply(value, stream, args);
              }
            : (...args: unknown[]) => reflectApply(value, stream, args);
      mapSet(methods, key, method);
      return method;
    },
  };
  const guarded = new ProxyConstructor(target, handler);
  owned?.(guarded);
  return guarded;
}
