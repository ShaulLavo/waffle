import { MemFS, type Node } from "../../fs/memory.js";
import type { ResolvedPath } from "../../core/filesystem.js";
import type { Operation, State } from "./protocol.js";

export function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("INVALID: number");
  return value;
}
export function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("INVALID: text");
  return value;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("INVALID: object");
  return Object.fromEntries(Object.entries(value));
}
function nodes(node: Node): Node[] {
  return node.kind === "file" ? [node] : [node].concat(Array.from(node.children.values()).flatMap(nodes));
}
function handle(fs: MemFS, id: unknown): number {
  const node = nodes(fs.root).find((entry) => entry.ino === number(id));
  if (!node) throw new Error("MISSING: inode");
  return fs.handleForNode(node);
}
function identity(fs: MemFS, local: number): number {
  return fs.stat(local).ino;
}
function pathOut(fs: MemFS, path: ResolvedPath): ResolvedPath {
  return { ...path, node: path.node === undefined ? undefined : identity(fs, path.node),
    parent: path.parent === undefined ? undefined : identity(fs, path.parent) };
}
function pathIn(fs: MemFS, value: unknown): ResolvedPath {
  const path = object(value);
  return { name: text(path.name), node: path.node === undefined ? undefined : handle(fs, path.node),
    parent: path.parent === undefined ? undefined : handle(fs, path.parent),
    trailingSlash: path.trailingSlash === true, terminalDot: path.terminalDot === true };
}
function resolved(fs: MemFS, path: string): ResolvedPath {
  const result = fs.resolveAbsolute(path);
  if (typeof result === "number") throw new Error(`FILESYSTEM: resolve errno ${result}`);
  return result;
}
function guestRead(fs: MemFS, args: unknown[]): number[] {
  const bytes = new Uint8Array(number(args[1]));
  const count = fs.read(handle(fs, args[0]), [bytes], number(args[2]));
  if (count < 0) throw new Error(`FILESYSTEM: read errno ${count}`);
  return Array.from(bytes.subarray(0, count));
}
function guest(fs: MemFS, operation: Extract<Operation, { kind: "guest" }>): unknown {
  const [a, b, c] = operation.args;
  const bytes = Uint8Array.from(operation.bytes);
  switch (operation.method) {
    case "preopen": return identity(fs, fs.preopen(text(a)));
    case "resolve": {
      const result = fs.resolve(handle(fs, a), text(b));
      return typeof result === "number" ? result : pathOut(fs, result);
    }
    case "stat": return fs.stat(handle(fs, a));
    case "read": return guestRead(fs, operation.args);
    case "write": return fs.write(handle(fs, a), [bytes], number(b));
    case "append": return fs.append(handle(fs, a), [bytes]);
    case "resize": return fs.resize(handle(fs, a), number(b), c === true);
    case "setMtime": return fs.setMtime(handle(fs, a), number(b));
    case "readdir": return fs.readdir(handle(fs, a));
    case "create": {
      if (b !== "file" && b !== "directory") throw new Error("INVALID: kind");
      const result = fs.create(pathIn(fs, a), b, c === true);
      return typeof result === "number" ? identity(fs, result) : result;
    }
    case "rename": return fs.rename(pathIn(fs, a), pathIn(fs, b));
    default: throw new Error(`UNSUPPORTED: guest ${operation.method}`);
  }
}
export function perform(state: State, operation: Operation): unknown {
  const fs = new MemFS(state.root);
  switch (operation.kind) {
    case "write": fs.writeFile(operation.path, operation.text); return describe(state, operation.path);
    case "append": {
      const node = fs.lookup(operation.path);
      if (!node || node.kind !== "file") throw new Error("MISSING: append path");
      const result = fs.append(fs.handleForNode(node), [new TextEncoder().encode(operation.text)]);
      return { append: result, file: describe(state, operation.path) };
    }
    case "rename": {
      const errno = fs.rename(resolved(fs, operation.from), resolved(fs, operation.to));
      if (errno) throw new Error(`FILESYSTEM: rename errno ${errno}`);
      return describe(state, operation.to);
    }
    case "read": return describe(state, operation.path);
    case "snapshot": return nodes(state.root).map((node) => ({ id: node.ino, kind: node.kind,
      size: node.kind === "file" ? node.data.length : 0, version: state.versions.get(node.ino) ?? 0 }));
    case "guest": return guest(fs, operation);
    default: throw new Error("INVALID: non-filesystem operation");
  }
}
export function describe(state: State, path: string) {
  const node = new MemFS(state.root).lookup(path);
  if (!node || node.kind !== "file") return null;
  return { id: node.ino, path, version: state.versions.get(node.ino) ?? 0,
    size: node.data.length, text: new TextDecoder().decode(node.data) };
}
export function bumpVersions(before: State, next: State): void {
  const previous = new Map(nodes(before.root).map((node) => [node.ino, node]));
  for (const node of nodes(next.root)) bumpVersion(previous.get(node.ino), node, next);
}
function bumpVersion(old: Node | undefined, node: Node, next: State): void {
  if (node.kind !== "file") return;
  const unchanged = old?.kind === "file" && old.mtime === node.mtime &&
    old.data.length === node.data.length && old.data.every((byte, index) => byte === node.data[index]);
  if (!unchanged) next.versions.set(node.ino, (next.versions.get(node.ino) ?? 0) + 1);
}
export function enforceBounds(state: State): void {
  const entries = nodes(state.root);
  const size = entries.reduce((sum, node) => sum + (node.kind === "file" ? node.data.length : 0), 0);
  if (size > 1024 * 1024 || entries.length > 128) throw new Error("BACKPRESSURE: tree budget");
}
