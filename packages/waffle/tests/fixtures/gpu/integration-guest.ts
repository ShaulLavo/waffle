import {
  bootstrap,
  preview1Executor,
  type RuntimeWorkerRequest,
  type RuntimeWorkerHost,
} from "../../../browser/worker.js";
import { RecordRing } from "../../../browser/gpu/ring.js";
import { poisonProcessIntrinsics } from "../process-intrinsics.js";
import { sharedArrayBufferByteLength } from "../../../proc/intrinsics.js";
import { consumedControlBytes } from "../../../memory/control.js";
import { importUnwind } from "./import-unwind.js";
import { thrownObservation } from "./thrown-observation.js";

const host = globalThis as unknown as {
  onmessage: (event: MessageEvent<RuntimeWorkerRequest>) => Promise<void>;
};
const send = globalThis.postMessage.bind(globalThis);
const apply = Reflect.apply;
let importCall = 0;
const wait = RecordRing.prototype.wait;
let waiting: { token: string; call: number; name: string; reported: boolean } | undefined;
function observeWait(this: RecordRing, seen: number, timeout: number, live: () => void) {
  if (waiting && !waiting.reported) {
    waiting.reported = true;
    send({
      gpuImport: { token: waiting.token, call: waiting.call, name: waiting.name, phase: "wait" },
    });
  }
  return apply(wait, this, [seen, timeout, live]);
}
type PayloadObservation = { enabled: boolean; memory: () => WebAssembly.Memory | undefined };
type QuotaObservation =
  | (() => { consumed: number; limit: number; receiptBytes: number; lengths: number[] })
  | undefined;
type AuthorityObservation = () =>
  | ReturnType<ReturnType<typeof poisonProcessIntrinsics>["restore"]>
  | undefined;
function observeImports(
  imports: WebAssembly.Imports,
  token: string | undefined,
  quota: QuotaObservation,
  payload: PayloadObservation,
  authority: AuthorityObservation,
): void {
  if (!token || !imports.runtime_gpu) return;
  RecordRing.prototype.wait = observeWait;
  for (const name of ["open", "append", "completions"].concat(
    payload.enabled ? ["payload", "close"] : quota ? ["close"] : [],
  )) {
    const original = imports.runtime_gpu[name];
    if (typeof original !== "function") throw new Error("Missing observed GPU import");
    imports.runtime_gpu[name] = observedImport(original, token, name, quota, payload, authority);
  }
}
function observeThrow(
  error: unknown,
  site: "import" | "return-observer",
  call: { token: string; call: number; name: string },
): void {
  let unwind: ReturnType<typeof importUnwind>;
  try {
    if (site === "import") unwind = importUnwind(error);
  } catch {}
  try {
    const gpuImport = { ...call, phase: "throw", unwind };
    send({
      gpuImport: unwind ? gpuImport : { ...gpuImport, exception: thrownObservation(error, site) },
    });
  } catch {}
}
export function observedImport(
  original: Function,
  token: string,
  name: string,
  quota: QuotaObservation,
  payload: PayloadObservation,
  authority: AuthorityObservation,
) {
  return function (this: unknown, ...args: (number | bigint)[]) {
    const call = ++importCall;
    waiting = { token, call, name, reported: false };
    send({
      gpuImport: {
        token,
        call,
        name,
        phase: "enter",
        connection: args[0],
        length: args[2],
        authority: authority(),
        quota: quota?.(),
        payload:
          payload.enabled && name === "payload" ? payloadHandle(payload.memory(), args) : undefined,
      },
    });
    let site: "import" | "return-observer" = "import";
    try {
      const result = apply(original, this, args);
      site = "return-observer";
      send({
        gpuImport: {
          token,
          call,
          name,
          phase: "return",
          result,
          quota: quota?.(),
          records:
            payload.enabled && name === "completions" && result === 0
              ? completionRecords(payload.memory(), args)
              : undefined,
        },
      });
      return result;
    } catch (error) {
      observeThrow(error, site, { token, call, name });
      throw error;
    } finally {
      waiting = undefined;
    }
  };
}
function payloadHandle(memory: WebAssembly.Memory | undefined, args: readonly (number | bigint)[]) {
  if (!memory || typeof args[1] !== "number") throw new Error("Missing payload import memory");
  const view = new DataView(memory.buffer, args[1], 8);
  return { handle: view.getUint32(0, true), generation: view.getUint32(4, true) };
}
function completionRecords(
  memory: WebAssembly.Memory | undefined,
  args: readonly (number | bigint)[],
) {
  if (!memory || typeof args[1] !== "number" || typeof args[4] !== "number")
    throw new Error("Missing completion import memory");
  const written = new DataView(memory.buffer).getUint32(args[4], true);
  const view = new DataView(memory.buffer, args[1], written);
  const records: { kind: number; bytes: number; token: number; status: number; words: number[] }[] =
    [];
  for (let offset = 0; offset < written;) {
    const bytes = view.getUint32(offset + 4, true);
    if (bytes < 16 || offset + bytes > written)
      throw new Error("Invalid observed completion framing");
    records.push({
      kind: view.getUint16(offset, true),
      bytes,
      token: view.getUint32(offset + 8, true),
      status: view.getInt32(offset + 12, true),
      words: Array.from({ length: (bytes - 16) / 4 }, (_, index) =>
        view.getUint32(offset + 16 + index * 4, true),
      ),
    });
    offset += bytes;
  }
  return records;
}
const add = globalThis.addEventListener.bind(globalThis),
  remove = globalThis.removeEventListener.bind(globalThis);
host.onmessage = async ({ data }) => {
  let poison: ReturnType<typeof poisonProcessIntrinsics> | undefined;
  const receipts: SharedArrayBuffer[] = [];
  const receiptLengths: number[] = [];
  let receiptBytes = 0;
  const quota =
    data.env.GPU_GRANT_QUOTA === "1"
      ? () => ({
          consumed: consumedControlBytes(data.controlGrant),
          limit: data.controlGrant.kind === "bounded" ? data.controlGrant.limit : 0,
          receiptBytes,
          lengths: receiptLengths.slice(),
        })
      : undefined;
  let memory: WebAssembly.Memory | undefined;
  let actualId = 0;
  const embedding: RuntimeWorkerHost = {
    crossOriginIsolated,
    postMessage(message, transfer) {
      if (message.type === "shared-control-allocation") {
        receipts[receipts.length] = message.buffer;
        receiptLengths.push(sharedArrayBufferByteLength(message.buffer));
        receiptBytes += sharedArrayBufferByteLength(message.buffer);
        poison?.track(message.buffer);
      }
      send(message, transfer ?? []);
    },
    addEventListener: (type, listener) => add(type, listener as EventListener),
    removeEventListener: (type, listener) => remove(type, listener as EventListener),
  };
  await bootstrap(
    data,
    {
      ...preview1Executor,
      imports(imports) {
        observeImports(
          imports,
          data.env.GPU_OWNERSHIP_TOKEN,
          quota,
          { enabled: data.args.includes("--payload-pressure"), memory: () => memory },
          () => {
            if (data.env.GPU_OWNERSHIP_VICTIM !== "1" || !poison) return undefined;
            const report = poison.restore();
            const buffers = receipts.concat(
              data.graphics?.surfaces.map((surface) => surface.info) ?? [],
              data.graphics ? [data.graphics.revocation] : [],
            );
            poison = poisonProcessIntrinsics(buffers);
            return report;
          },
        );
        if (data.env.GPU_FORGE !== "1" || !imports.runtime_window) return;
        const originalSurfaces = imports.runtime_window.surfaces,
          originalInfo = imports.runtime_window.surface_info;
        if (typeof originalSurfaces !== "function" || typeof originalInfo !== "function")
          throw new Error("Missing window imports");
        imports.runtime_window.surfaces = (ptr: number, length: number) => {
          const count = originalSurfaces(ptr, length);
          if (count > 0 && memory) {
            const view = new DataView(memory.buffer);
            actualId = view.getUint32(ptr, true);
            view.setUint32(ptr, 0xdead, true);
          }
          return count;
        };
        imports.runtime_window.surface_info = (_id: number, ptr: number) =>
          originalInfo(actualId, ptr);
      },
      initialize(context) {
        const exported = context.instance.exports.memory;
        if (exported instanceof WebAssembly.Memory) memory = exported;
        if (data.env.GPU_POISON !== "1") return;
        const buffers = receipts.concat(
          data.graphics?.surfaces.map((surface) => surface.info) ?? [],
          data.graphics ? [data.graphics.revocation] : [],
        );
        poison = poisonProcessIntrinsics(buffers);
      },
      beforeFinish() {
        if (!poison) return;
        const report = poison.restore();
        poison = undefined;
        send({ gpuAuthority: report, gpuAuthorityToken: data.env.GPU_AUTHORITY_TOKEN });
      },
    },
    embedding,
  );
};
