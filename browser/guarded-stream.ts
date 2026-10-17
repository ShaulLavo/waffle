import type { Stream } from "../core/descriptors";

/** Preserve endpoint prototypes, private receivers and optional immediate I/O while guarding
 * every admission operation. Cleanup remains available after logical death. */
export function guardedStream(stream: Stream, checkActive: () => void, owned?: (stream: Stream) => void): Stream {
  const methods = new Map<PropertyKey, unknown>();
  const guarded = new Proxy(stream, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (methods.has(key)) return methods.get(key);
      const method = key === "forProcess"
        ? (pid: number) => { checkActive(); return guardedStream(value.call(target, pid), checkActive, owned); }
        : key === "read" || key === "write" || key === "tryRead" || key === "tryWrite" || key === "readiness"
          ? (...args: unknown[]) => { checkActive(); return value.apply(target, args); }
          : value.bind(target);
      methods.set(key, method);
      return method;
    },
  });
  owned?.(guarded);
  return guarded;
}
