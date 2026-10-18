/** Implementation controls are for conformance tests and experiments, not product selection. */
export type VfsImplementation = "indexeddb" | "opfs-memory" | "memory";
export const vfsImplementation = Symbol("waffle.internal.vfs-implementation");

export function withVfsImplementation<const T extends object>(
  implementation: VfsImplementation,
  options: T,
): T & { [vfsImplementation]: VfsImplementation } {
  return { ...options, [vfsImplementation]: implementation };
}
