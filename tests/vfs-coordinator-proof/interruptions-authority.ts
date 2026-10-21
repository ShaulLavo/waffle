const nativeRequest = navigator.locks.request.bind(navigator.locks);
if (location.href.includes("reject-volatile")) {
  Object.defineProperty(navigator.locks, "request", {
    value: (name: string, options: LockOptions, callback: LockGrantedCallback) =>
      nativeRequest(name, name.startsWith("e5-volatile:")
        ? { ...options, signal: AbortSignal.abort(new Error("injected lock-request rejection")) }
        : options, callback),
  });
}
await import("./authority.js");
