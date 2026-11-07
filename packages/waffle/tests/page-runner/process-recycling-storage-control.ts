/** A real successful memory-only fixture must never reach a durable open in either realm. */
export function forbidDurableProcessStorage(): void {
  const forbidden = () => {
    throw new Error("PROCESS_CONTROL_DURABLE_OPEN");
  };
  Object.defineProperty(IDBFactory.prototype, "open", { configurable: true, value: forbidden });
  Object.defineProperty(StorageManager.prototype, "getDirectory", {
    configurable: true,
    value: forbidden,
  });
}
