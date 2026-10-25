import { FilesystemError, type DirectoryEntry } from "../core/filesystem.js";

export const MAX_DIRECTORY_PAGE_BYTES = 0xffffffff;
const MAX_COOKIE = (1n << 64n) - 1n;
const encoder = new TextEncoder();

type Entry = DirectoryEntry & { cookie: bigint; bytes: Uint8Array };
interface Branch {
  entry: Entry;
  left: Branch | undefined;
  right: Branch | undefined;
  height: number;
}
function height(branch: Branch | undefined): number {
  return branch?.height ?? 0;
}
function update(branch: Branch): Branch {
  branch.height = 1 + Math.max(height(branch.left), height(branch.right));
  return branch;
}
function rotateLeft(branch: Branch): Branch {
  const next = branch.right!;
  branch.right = next.left;
  next.left = update(branch);
  return update(next);
}
function rotateRight(branch: Branch): Branch {
  const next = branch.left!;
  branch.left = next.right;
  next.right = update(branch);
  return update(next);
}
function balance(branch: Branch): Branch {
  update(branch);
  const skew = height(branch.left) - height(branch.right);
  if (skew > 1) {
    if (height(branch.left!.right) > height(branch.left!.left))
      branch.left = rotateLeft(branch.left!);
    return rotateRight(branch);
  }
  if (skew < -1) {
    if (height(branch.right!.left) > height(branch.right!.right))
      branch.right = rotateRight(branch.right!);
    return rotateLeft(branch);
  }
  return branch;
}
function insert(branch: Branch | undefined, entry: Entry): Branch {
  if (!branch) return { entry, left: undefined, right: undefined, height: 1 };
  if (entry.cookie < branch.entry.cookie) branch.left = insert(branch.left, entry);
  else branch.right = insert(branch.right, entry);
  return balance(branch);
}
function remove(branch: Branch | undefined, cookie: bigint): Branch | undefined {
  if (!branch) return;
  if (cookie < branch.entry.cookie) branch.left = remove(branch.left, cookie);
  else if (cookie > branch.entry.cookie) branch.right = remove(branch.right, cookie);
  else {
    if (!branch.left) return branch.right;
    if (!branch.right) return branch.left;
    let successor = branch.right;
    while (successor.left) successor = successor.left;
    branch.entry = successor.entry;
    branch.right = remove(branch.right, successor.entry.cookie);
  }
  return balance(branch);
}

export function checkDirectoryPage(cookie: unknown, byteLength: unknown): void {
  if (typeof cookie !== "bigint" || cookie < 0n || cookie > MAX_COOKIE)
    throw new FilesystemError(28, "invalid directory cookie");
  if (
    typeof byteLength !== "number" ||
    !Number.isInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > MAX_DIRECTORY_PAGE_BYTES
  )
    throw new FilesystemError(28, "invalid directory page size");
}

function encodeEntry(output: Uint8Array, offset: number, entry: Entry): number {
  const header = new Uint8Array(24);
  const view = new DataView(header.buffer);
  view.setBigUint64(0, entry.cookie, true);
  view.setBigUint64(8, BigInt(entry.ino), true);
  view.setUint32(16, entry.bytes.length, true);
  view.setUint8(20, entry.kind === "directory" ? 3 : entry.kind === "symlink" ? 7 : 4);
  const headerLength = Math.min(header.length, output.length - offset);
  output.set(header.subarray(0, headerLength), offset);
  offset += headerLength;
  const nameLength = Math.min(entry.bytes.length, output.length - offset);
  output.set(entry.bytes.subarray(0, nameLength), offset);
  return offset + nameLength;
}

/** Live edges only. Cookie successor search never replays a directory prefix. */
export class DirectoryPages {
  private root: Branch | undefined;
  private names = new Map<string, bigint>();
  private next = 3n;

  reserve(count: number): void {
    if (this.next + BigInt(count) - 1n > MAX_COOKIE)
      throw new FilesystemError(61, "directory cookies exhausted");
  }
  set(entry: DirectoryEntry): void {
    this.reserve(1);
    this.delete(entry.name);
    const cookie = this.next++;
    this.root = insert(this.root, { ...entry, cookie, bytes: encoder.encode(entry.name) });
    this.names.set(entry.name, cookie);
  }
  delete(name: string): void {
    const cookie = this.names.get(name);
    if (cookie === undefined) return;
    this.root = remove(this.root, cookie);
    this.names.delete(name);
  }
  clear(): void {
    this.root = undefined;
    this.names.clear();
  }
  *entriesAfter(cookie: bigint): Generator<Entry> {
    const pending: Branch[] = [];
    let branch = this.root;
    while (branch || pending.length) {
      if (!branch) {
        branch = pending.pop()!;
        yield branch.entry;
        branch = branch.right;
        continue;
      }
      if (branch.entry.cookie > cookie) pending.push(branch);
      branch = branch.entry.cookie > cookie ? branch.left : branch.right;
    }
  }
  private appendEntries(
    entries: Entry[],
    cookie: bigint,
    byteLength: number,
    size: number,
  ): number {
    for (const entry of this.entriesAfter(cookie)) {
      entries.push(entry);
      size += 24 + entry.bytes.length;
      if (size >= byteLength) break;
    }
    return size;
  }
  page(cookie: bigint, byteLength: number, ino: number, parent: number): Uint8Array {
    if (!byteLength) return new Uint8Array();
    const entries: Entry[] = [];
    let size = 0;
    const append = (entry: Entry) => {
      entries.push(entry);
      size += 24 + entry.bytes.length;
    };
    if (cookie < 1n)
      append({ name: ".", ino, kind: "directory", cookie: 1n, bytes: new Uint8Array([46]) });
    if (cookie < 2n && size < byteLength)
      append({
        name: "..",
        ino: parent,
        kind: "directory",
        cookie: 2n,
        bytes: new Uint8Array([46, 46]),
      });
    if (size < byteLength) size = this.appendEntries(entries, cookie, byteLength, size);
    const output = new Uint8Array(Math.min(byteLength, size));
    let used = 0;
    for (const entry of entries) used = encodeEntry(output, used, entry);
    return output;
  }
}
