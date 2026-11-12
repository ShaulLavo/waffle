type Detail = Record<string, unknown>;

/** Pass through native results and promises; observation never joins their lifetimes. */
export function installStorageLifecycleObserver(role: string): void {
  const realm = crypto.randomUUID();
  let sequence = 0;
  const emit = (event: string, detail: Detail = {}) => {
    console.log(
      `STORAGE_LIFECYCLE ${JSON.stringify({
        realm,
        role,
        sequence: ++sequence,
        time: performance.timeOrigin + performance.now(),
        event,
        ...detail,
      })}`,
    );
  };
  Reflect.set(globalThis, "waffleStorageLifecycle", emit);
  observeLocks(emit);
  observeDatabaseClose(emit);
  observeWorkers(emit);
  emit("installed");
}

function observeSettlement<T>(value: T, event: string, detail: Detail, emit: Emit): T {
  void Promise.resolve(value).then(
    () => emit(`${event}-fulfilled`, detail),
    (error: unknown) => emit(`${event}-rejected`, { ...detail, error: String(error) }),
  );
  return value;
}

type Emit = (event: string, detail?: Detail) => void;

function observeLocks(emit: Emit): void {
  const locks = navigator.locks;
  const native = locks.request.bind(locks);
  const query = locks.query.bind(locks);
  let ordinal = 0;
  function snapshot(request: number, name: string, phase: string): void {
    void query().then(
      (state) => emit("lock-snapshot", { request, name, phase, ...state }),
      (error: unknown) => emit("lock-snapshot-error", { request, name, error: String(error) }),
    );
  }
  function request<T>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    callback?: LockGrantedCallback<T>,
  ): Promise<Awaited<T>> {
    const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
    const granted = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
    if (!granted) throw new Error("Missing lock callback");
    const id = ++ordinal;
    const detail = { request: id, name, mode: options.mode ?? "exclusive", options };
    emit("lock-request", detail);
    const result = native(name, options, (lock) => {
      emit("lock-callback", { ...detail, granted: lock !== null });
      snapshot(id, name, "callback");
      return observeSettlement(granted(lock), "lock-callback", detail, emit);
    });
    snapshot(id, name, "submitted");
    return observeSettlement(result, "lock-request", detail, emit);
  }
  locks.request = request;
}

function observeDatabaseClose(emit: Emit): void {
  const close = IDBDatabase.prototype.close;
  IDBDatabase.prototype.close = function () {
    emit("database-close-call", { name: this.name });
    const result = close.call(this);
    emit("database-close-return", { name: this.name });
    return result;
  };
}

function messageKind(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if ("dispose" in value && value.dispose === true) return "dispose";
  if ("type" in value && typeof value.type === "string") return value.type;
  return undefined;
}

function observeWorkers(emit: Emit): void {
  const identities = new WeakMap<Worker, string>();
  const NativeWorker = Worker;
  globalThis.Worker = new Proxy(NativeWorker, {
    construct(target, args, newTarget) {
      const worker: Worker = Reflect.construct(target, args, newTarget);
      const workerId = crypto.randomUUID();
      identities.set(worker, workerId);
      emit("worker-created", { worker: workerId, url: String(args[0]) });
      worker.addEventListener("message", (event: MessageEvent<unknown>) => {
        const type = messageKind(event.data);
        if (type) emit("worker-message", { worker: workerId, type });
      });
      return worker;
    },
  });
  NativeWorker.prototype.postMessage = new Proxy(NativeWorker.prototype.postMessage, {
    apply(target, worker: Worker, args: unknown[]) {
      const type = messageKind(args[0]);
      if (type) emit("worker-post", { worker: identities.get(worker), type });
      return Reflect.apply(target, worker, args);
    },
  });
  NativeWorker.prototype.terminate = new Proxy(NativeWorker.prototype.terminate, {
    apply(target, worker: Worker, args: unknown[]) {
      emit("worker-terminate", { worker: identities.get(worker) });
      return Reflect.apply(target, worker, args);
    },
  });
  globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (messageKind(event.data) === "dispose") emit("service-dispose-received");
  });
  const post: unknown = Reflect.get(globalThis, "postMessage");
  if (typeof post !== "function") return;
  Reflect.set(
    globalThis,
    "postMessage",
    new Proxy(post, {
      apply(target, scope: unknown, args: unknown[]) {
        if (messageKind(args[0]) === "filesystem-disposed")
          emit("service-ack-post", { message: args[0] });
        return Reflect.apply(target, scope, args);
      },
    }),
  );
}
