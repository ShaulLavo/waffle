import { bigintToString } from "../proc/intrinsics.js";
import type { FileId } from "./file-identity.js";
import type { NamespaceRecord } from "./workspace-protocol.js";
import type { PublicationEffect, PublicationFile } from "./publication.js";
import { WORKSPACE_LIMITS, type WorkspaceChange } from "./workspace-types.js";

interface Edge {
  readonly parent: FileId;
  readonly name: string;
  readonly charge: number;
}
interface IndexedNode {
  readonly kind: "file" | "directory" | "symlink";
  readonly links: Map<string, Edge>;
}
export class ProjectionPressure extends Error {
  constructor(readonly resource: "index" | "changes") {
    super(resource);
  }
}
export class ChangeBudget {
  private used = 0;
  take(bytes: number): void {
    if (this.used + bytes > WORKSPACE_LIMITS.changeBytes) throw new ProjectionPressure("changes");
    this.used += bytes;
  }
}
function key(parent: FileId, name: string): string {
  return `${bigintToString(parent, 16)}/${name}`;
}
function reference(file: PublicationFile | null) {
  return file ? { id: file.id, version: file.version } : null;
}
/** Derived history index only. Never used to authorize reads or mutations. */
export class NamespaceIndex {
  private nodes = new Map<FileId, IndexedNode>();
  private root: FileId | undefined;
  private bytes = 0;
  private edges = 0;
  add(record: NamespaceRecord): void {
    this.node(record.id, record.kind);
    if (record.parent === null) {
      this.root = record.id;
      return;
    }
    this.link(record.id, record.parent, record.name);
  }
  private reserve(bytes: number): void {
    if (this.bytes + bytes > WORKSPACE_LIMITS.indexBytes) throw new ProjectionPressure("index");
    this.bytes += bytes;
  }
  private node(id: FileId, kind: IndexedNode["kind"]): IndexedNode {
    const previous = this.nodes.get(id);
    if (previous) return previous;
    this.reserve(128);
    const node: IndexedNode = { kind, links: new Map() };
    this.nodes.set(id, node);
    return node;
  }
  private link(id: FileId, parent: FileId, name: string): void {
    const node = this.nodes.get(id) ?? this.node(id, "file");
    const edgeKey = key(parent, name);
    if (node.links.has(edgeKey)) return;
    if (this.edges >= WORKSPACE_LIMITS.indexEdges) throw new ProjectionPressure("index");
    const charge = 128 + 2 * (edgeKey.length + name.length);
    this.reserve(charge);
    node.links.set(edgeKey, { parent, name, charge });
    this.edges++;
  }
  private unlink(id: FileId, parent: FileId, name: string): void {
    const node = this.nodes.get(id),
      edgeKey = key(parent, name);
    const previous = node?.links.get(edgeKey);
    if (!node || !previous) return;
    node.links.delete(edgeKey);
    this.bytes -= previous.charge;
    this.edges--;
  }
  private directoryPath(id: FileId): string | null {
    const parts: string[] = [];
    let current = id,
      length = 0;
    while (current !== this.root) {
      if (parts.length >= WORKSPACE_LIMITS.depth) throw new ProjectionPressure("changes");
      const node = this.nodes.get(current);
      const edge = node?.links.values().next().value;
      if (!edge) return null;
      length += edge.name.length + 1;
      if (length > WORKSPACE_LIMITS.pathUnits) throw new ProjectionPressure("changes");
      parts.push(edge.name);
      current = edge.parent;
    }
    parts.reverse();
    return `/${parts.join("/")}`;
  }
  private entryPath(parent: FileId, name: string, budget: ChangeBudget): string | null {
    const directory = this.directoryPath(parent);
    if (directory === null) return null;
    const length = directory.length + name.length + (directory === "/" ? 0 : 1);
    if (length > WORKSPACE_LIMITS.pathUnits) throw new ProjectionPressure("changes");
    budget.take(length * 2 + 32);
    return directory === "/" ? `/${name}` : `${directory}/${name}`;
  }
  private paths(id: FileId, budget: ChangeBudget): readonly string[] {
    if (id === this.root) {
      budget.take(34);
      return ["/"];
    }
    const node = this.nodes.get(id);
    if (!node) return [];
    const paths: string[] = [];
    for (const edge of node.links.values()) {
      const path = this.entryPath(edge.parent, edge.name, budget);
      if (path !== null) paths.push(path);
    }
    paths.sort();
    return paths;
  }
  project(effects: readonly PublicationEffect[], budget: ChangeBudget): readonly WorkspaceChange[] {
    const oldPaths = new Map<PublicationEffect, string | null>();
    for (const effect of effects) {
      budget.take(256);
      if (effect.kind === "entry" && effect.before)
        oldPaths.set(effect, this.entryPath(effect.parent.id, effect.name, budget));
      if (effect.kind === "inode") this.node(effect.file.id, effect.nodeKind);
    }
    for (const effect of effects) this.apply(effect);
    const changes = effects.map((effect) => this.change(effect, oldPaths, budget));
    for (const effect of effects)
      if (effect.kind === "entry" && effect.before) this.collect(effect.before.id);
    return changes;
  }
  private apply(effect: PublicationEffect): void {
    if (effect.kind !== "entry") return;
    this.node(effect.parent.id, "directory");
    if (effect.before) this.unlink(effect.before.id, effect.parent.id, effect.name);
    if (effect.after) this.link(effect.after.id, effect.parent.id, effect.name);
  }
  private collect(id: FileId): void {
    const node = this.nodes.get(id);
    if (id === this.root || !node || node.links.size) return;
    this.nodes.delete(id);
    this.bytes -= 128;
  }
  private change(
    effect: PublicationEffect,
    oldPaths: ReadonlyMap<PublicationEffect, string | null>,
    budget: ChangeBudget,
  ): WorkspaceChange {
    if (effect.kind === "entry")
      return {
        kind: "entry",
        parent: { id: effect.parent.id, version: effect.parent.version },
        name: effect.name,
        before: reference(effect.before),
        after: reference(effect.after),
        beforePath: oldPaths.get(effect) ?? null,
        afterPath: effect.after ? this.entryPath(effect.parent.id, effect.name, budget) : null,
      };
    const file = {
      id: effect.file.id,
      version: effect.file.version,
      paths: this.paths(effect.file.id, budget),
    };
    switch (effect.kind) {
      case "bytes":
        return {
          ...file,
          kind: "write",
          range: { offset: effect.offset, length: effect.bytes.length },
          size: effect.size,
        };
      case "resize":
        return { ...file, kind: "resize", size: effect.size };
      case "metadata":
        return { ...file, kind: "metadata", mode: effect.mode, mtime: effect.mtime };
      case "inode":
        if (effect.nodeKind === "symlink")
          budget.take(effect.target.length * 2 + new TextEncoder().encode(effect.target).length);
        return {
          ...file,
          kind: "inode",
          ...(effect.nodeKind === "symlink"
            ? { nodeKind: "symlink", target: effect.target }
            : { nodeKind: effect.nodeKind }),
          mode: effect.mode,
          mtime: effect.mtime,
        };
      default: {
        const exhaustive: never = effect;
        return exhaustive;
      }
    }
  }
}
