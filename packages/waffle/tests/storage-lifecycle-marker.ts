/** Installed only by the opt-in browser diagnosis runner. */
export function storageLifecycleMarker(event: string, name: string): void {
  const observe: unknown = Reflect.get(globalThis, "waffleStorageLifecycle");
  if (typeof observe === "function") observe(event, { name });
}
