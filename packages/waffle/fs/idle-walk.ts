import type {
  IdleWorkspaceWalk,
  IdleWorkspacePage,
  StoredWorkspaceEntry,
  IdleWorkspaceWalkOptions,
} from "./idle-workspace.js";
import { type Node, type MemFS, nodeSize, normalize } from "./memory.js";
import { FilesystemError } from "./protocol.js";

interface PendingEntry {
  readonly node: Node;
  readonly path: string;
}

export class IdleWalk implements IdleWorkspaceWalk {
  private readonly pending: PendingEntry[] = [];
  private closed: Promise<void> | undefined;
  private readonly ignored: ReadonlySet<string>;
  private readonly signal: AbortSignal | undefined;
  private readonly abort = () => {
    void this.close();
  };

  constructor(
    tree: MemFS | undefined,
    path: string,
    private readonly links: ReadonlyMap<number, number>,
    private readonly check: () => void,
    private readonly onClose: () => void,
    options: IdleWorkspaceWalkOptions,
  ) {
    check();
    this.signal = options.signal;
    this.signal?.throwIfAborted();
    this.ignored = ignoreRoots(options.ignoreRoots ?? []);
    if (path.includes("\0")) throw new FilesystemError(28);
    const selected = normalize(path.startsWith("/") ? path : `/${path}`);
    for (const root of this.ignored)
      if (root === "/" || root === selected || selected.startsWith(`${root}/`))
        throw new RangeError("An ignored root must not contain the selected entry");
    if (!tree) return;
    const node = selectEntry(tree, selected);
    if (node) this.pending.push({ node, path: selected });
    this.signal?.addEventListener("abort", this.abort, { once: true });
  }

  async next(): Promise<IdleWorkspacePage> {
    try {
      this.check();
      this.signal?.throwIfAborted();
      if (this.closed) return { entries: [], done: true };
      const entries: StoredWorkspaceEntry[] = [];
      while (this.pending.length && entries.length < 256) {
        const entry = this.pending.pop();
        if (entry) entries.push(this.visit(entry));
      }
      const done = this.pending.length === 0;
      if (done) await this.close();
      return { entries, done };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private visit({ node, path }: PendingEntry): StoredWorkspaceEntry {
    if (node.kind === "dir") {
      if ((node.mode & 0o500) !== 0o500) throw new FilesystemError(2);
      for (const [name, child] of node.children) {
        const childPath = path === "/" ? `/${name}` : `${path}/${name}`;
        if (!this.ignored.has(childPath)) this.pending.push({ node: child, path: childPath });
      }
    }
    return {
      path,
      kind: node.kind,
      ino: node.ino,
      nlink: this.links.get(node.ino) ?? 0,
      mode: node.mode,
      size: nodeSize(node),
      mtime: node.mtime,
      ...(node.kind === "symlink" ? { target: node.target } : {}),
    };
  }

  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.pending.length = 0;
    this.signal?.removeEventListener("abort", this.abort);
    this.onClose();
    this.closed = Promise.resolve();
    return this.closed;
  }
}

function selectEntry(tree: MemFS, path: string): Node | undefined {
  let node: Node | undefined = tree.root;
  for (const part of path.split("/")) {
    if (!part) continue;
    if (!node) return;
    if (node.kind !== "dir") throw new FilesystemError(54);
    if (!(node.mode & 0o100)) throw new FilesystemError(2);
    node = node.children.get(part);
  }
  return node;
}

function ignoreRoots(roots: readonly string[]): ReadonlySet<string> {
  const ignored = new Set<string>();
  for (const root of roots) {
    if (
      typeof root !== "string" ||
      !root.startsWith("/") ||
      root.includes("\0") ||
      (root !== "/" &&
        root
          .slice(1)
          .split("/")
          .some((part) => !part || part === "." || part === ".."))
    )
      throw new TypeError("ignoreRoots requires absolute canonical paths");
    ignored.add(root);
  }
  return ignored;
}
