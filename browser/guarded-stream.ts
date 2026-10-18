import type { Stream } from "../core/descriptors.js";

/** Preserve endpoint prototypes, private receivers and optional immediate I/O while guarding
 * every admission operation. Cleanup remains available after logical death. */
export function guardedStream(stream: Stream, checkActive: () => void, owned?: (stream: Stream) => void): Stream {
  const methods = new Map<PropertyKey, unknown>();
  // Keep instanceof identity without proxying frozen own properties: wrapped methods must
  // differ from their originals, which a non-configurable target property would forbid.
  const target: Stream = Object.create(Object.getPrototypeOf(stream));
  const guarded = new Proxy(target, {
    get(_target, key) {
      const value = Reflect.get(stream, key, stream);
      if (typeof value !== "function") return value;
      if (methods.has(key)) return methods.get(key);
      const method = key === "forProcess"
        ? (pid: number) => { checkActive(); return guardedStream(value.call(stream, pid), checkActive, owned); }
        : key === "read" || key === "write" || key === "tryRead" || key === "tryWrite" || key === "readiness"
          ? (...args: unknown[]) => { checkActive(); return value.apply(stream, args); }
          : value.bind(stream);
      methods.set(key, method);
      return method;
    },
  });
  owned?.(guarded);
  return guarded;
}
