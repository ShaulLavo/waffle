import { FilesystemError, type DirectoryEntry } from "../core/filesystem.js";

export const MAX_DIRECTORY_PAGE_BYTES = 0xffffffff;
const MAX_COOKIE = (1n << 64n) - 1n;
const encoder = new TextEncoder();

type Entry = DirectoryEntry & { cookie: bigint; bytes?: Uint8Array };
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

function buildTree(entries: Entry[], start: number, end: number): Branch | undefined {
  if (start >= end) return;
  const middle = start + Math.floor((end - start) / 2);
  return update({
    entry: entries[middle]!,
    left: buildTree(entries, start, middle),
    right: buildTree(entries, middle + 1, end),
    height: 1,
  });
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

function entryBytes(entry: Entry): Uint8Array {
  return (entry.bytes ??= encoder.encode(entry.name));
}

function encodeEntry(output: Uint8Array, view: DataView, offset: number, entry: Entry): number {
  const bytes = entryBytes(entry);
  const remaining = output.length - offset;
  const header = remaining < 24 ? new Uint8Array(24) : output;
  const headerView = remaining < 24 ? new DataView(header.buffer) : view;
  const start = remaining < 24 ? 0 : offset;
  headerView.setBigUint64(start, entry.cookie, true);
  headerView.setBigUint64(start + 8, BigInt(entry.ino), true);
  headerView.setUint32(start + 16, bytes.length, true);
  headerView.setUint8(
    start + 20,
    entry.kind === "directory" ? 3 : entry.kind === "symlink" ? 7 : entry.kind === "socket" ? 6 : 4,
  );
  if (remaining < 24) {
    output.set(header.subarray(0, remaining), offset);
    return output.length;
  }
  offset += 24;
  const nameLength = Math.min(bytes.length, output.length - offset);
  output.set(nameLength === bytes.length ? bytes : bytes.subarray(0, nameLength), offset);
  return offset + nameLength;
}

/** Live edges only. Cookie successor search never replays a directory prefix. */
export class DirectoryPages {
  private root: Branch | undefined;
  private names = new Map<string, Entry>();
  private indexed = false;
  private next = 3n;

  reserve(count: number): void {
    if (this.next + BigInt(count) - 1n > MAX_COOKIE)
      throw new FilesystemError(61, "directory cookies exhausted");
  }
  set(entry: DirectoryEntry): void {
    this.reserve(1);
    this.delete(entry.name);
    const cookie = this.next++;
    const indexedEntry = { ...entry, cookie };
    if (this.indexed) this.root = insert(this.root, indexedEntry);
    this.names.set(entry.name, indexedEntry);
  }
  delete(name: string): void {
    const entry = this.names.get(name);
    if (!entry) return;
    if (this.indexed) this.root = remove(this.root, entry.cookie);
    this.names.delete(name);
  }
  clear(): void {
    this.root = undefined;
    this.names.clear();
  }
  *entriesAfter(cookie: bigint): Generator<Entry> {
    if (!this.indexed) {
      const entries = Array.from(this.names.values());
      this.root = buildTree(entries, 0, entries.length);
      this.indexed = true;
    }
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
      size += 24 + entryBytes(entry).length;
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
      size += 24 + entryBytes(entry).length;
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
    const view = new DataView(output.buffer);
    let used = 0;
    for (const entry of entries) used = encodeEntry(output, view, used, entry);
    return output;
  }
}
