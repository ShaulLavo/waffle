export async function storageQuotaControl(action: "cap" | "reset"): Promise<boolean> {
  const result = Promise.withResolvers<boolean>();
  const receive = (event: MessageEvent) => {
    if (event.data?.kind !== "idle-quota-result") return;
    globalThis.removeEventListener("message", receive);
    if (event.data.error) result.reject(new Error(event.data.error));
    else result.resolve(event.data.active === true);
  };
  globalThis.addEventListener("message", receive);
  globalThis.postMessage({ idleQuota: action });
  return result.promise;
}
