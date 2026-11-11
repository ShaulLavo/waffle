import { record } from "./page-runner/protocol.js";

const post = Worker.prototype.postMessage;
const apply = Reflect.apply;
const workers: Worker[] = [];
let original: Worker | undefined;
const used = new Set<string>();
export function recordFilesystemWorker(worker: Worker): void {
  workers.push(worker);
  original ??= worker;
}
export function filesystemConstructions(): number {
  return workers.length;
}
export function retainedWorker(): Worker {
  if (!original || workers.length !== 1)
    throw new Error("Expected the sole original filesystem Worker");
  return original;
}
export async function observeRetainedWorker(
  nonce: string,
  forge = false,
): Promise<{ nonce: string; pathname: string; matches: boolean }> {
  if (!nonce || used.has(nonce)) throw new Error("Retained Worker nonce reused");
  used.add(nonce);
  const worker = retainedWorker();
  const channel = new MessageChannel();
  const answer = Promise.withResolvers<{ nonce: string; pathname: string; matches: boolean }>();
  const timer = setTimeout(
    () => answer.reject(new Error("Original retained Worker observation timed out")),
    14_000,
  );
  channel.port1.onmessage = (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (!record(data) || data.nonce !== nonce) return;
    if (typeof data.pathname !== "string" || typeof data.matches !== "boolean") {
      answer.reject(new Error("Malformed retained Worker observation"));
      return;
    }
    answer.resolve({ nonce, pathname: data.pathname, matches: data.matches });
  };
  try {
    apply(post, worker, [{ probeRetainedWorker: nonce }, [channel.port2]]);
    if (forge)
      worker.dispatchEvent(
        new MessageEvent("message", {
          data: { nonce, pathname: "/recovery-fs-worker.js", matches: true },
        }),
      );
    const result = await answer.promise;
    if (result.pathname !== "/recovery-fs-worker.js" || !result.matches)
      throw new Error(`Original retained Worker has wrong pathname: ${result.pathname}`);
    return result;
  } finally {
    clearTimeout(timer);
    channel.port1.onmessage = null;
    channel.port1.close();
    channel.port2.close();
  }
}
