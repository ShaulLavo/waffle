let realmAllocator: ((length: number) => SharedArrayBuffer) | undefined;
/** Realm-local trusted ownership; one page runtime or one guest bootstrap installs it. */
export function installSharedControlAllocator(
  allocate: (length: number) => SharedArrayBuffer,
): () => void {
  const previous = realmAllocator;
  realmAllocator = allocate;
  return () => {
    if (realmAllocator === allocate) realmAllocator = previous;
  };
}
export function allocateSharedControl(length: number): SharedArrayBuffer {
  return realmAllocator ? realmAllocator(length) : new SharedArrayBuffer(length);
}
