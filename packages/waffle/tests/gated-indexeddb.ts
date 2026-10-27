/** Hold only delivery of a real open's success; no lock, epoch or storage code is replaced. */
export function gatedIndexedDB(factory: IDBFactory, onOpened?: () => void, onClosed?: () => void) {
  let deliver: (() => void) | undefined;
  let released = false;
  let closed = 0;
  let opened!: () => void, failed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    opened = resolve;
    failed = reject;
  });
  const gated = new Proxy(factory, {
    get(target, key) {
      if (key !== "open") {
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: Parameters<IDBFactory["open"]>) => {
        const request = target.open(...args);
        let success: IDBOpenDBRequest["onsuccess"] = null;
        request.addEventListener(
          "error",
          () => failed(request.error ?? new Error("Gated IndexedDB open failed")),
          { once: true },
        );
        request.addEventListener(
          "blocked",
          () => failed(new Error("Gated IndexedDB open was blocked")),
          { once: true },
        );
        request.addEventListener("success", (event) => {
          const database = request.result;
          const close = database.close.bind(database);
          database.close = () => {
            closed++;
            close();
            onClosed?.();
          };
          deliver = () => {
            success?.call(request, event);
          };
          opened();
          onOpened?.();
          if (released) deliver();
        });
        return new Proxy(request, {
          get(target, key) {
            return key === "onsuccess" ? success : Reflect.get(target, key, target);
          },
          set(target, key, value) {
            if (key === "onsuccess") {
              success = value;
              return true;
            }
            return Reflect.set(target, key, value, target);
          },
        });
      };
    },
  });
  return {
    factory: gated,
    ready,
    get closed() {
      return closed;
    },
    release() {
      if (released) return;
      released = true;
      deliver?.();
    },
  };
}
