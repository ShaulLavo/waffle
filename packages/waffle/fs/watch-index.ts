import { FilesystemError } from "../core/filesystem.js";
import { RootWatchAccount } from "./watch-account.js";
import { WatchArena, type WatchGrowth } from "./watch-arena.js";
import { WatchIdIndex, watchId, setWatchId } from "./watch-id-index.js";
import { WatchNames, type WatchNameReservation } from "./watch-names.js";

const NODE_BYTES = 40;
const EDGE_BYTES = 32;
const DIRECTORY = 0x10000;
const INCOMING = 20;
const OUTGOING = 24;
const PINS = 32;
const LINKS = 36;
function edgeKey(parent: number, name: string): bigint {
  let hash = 2166136261;
  for (let at = 0; at < name.length; at++) hash = Math.imul(hash ^ name.charCodeAt(at), 16777619);
  return (BigInt(parent) << 64n) | BigInt(hash >>> 0);
}
function identity(id: bigint): void {
  if (id <= 0n || id >= 1n << 128n) throw new RangeError("invalid watch identity");
}

/** Lazy live topology only. Committed effects own transaction ordering and final collection. */
export class WatchIndex {
  private readonly nodes: WatchArena;
  private readonly edges: WatchArena;
  private readonly names: WatchNames;
  private readonly identities: WatchIdIndex;
  private readonly entryKeys: WatchIdIndex;
  private root = 0n;
  private nodeTail = 0;
  private edgeTail = 0;
  private freeNode = 0;
  private freeEdge = 0;
  private nodeCount = 0;
  private edgeCount = 0;
  private stopped = false;
  constructor(private readonly account: RootWatchAccount) {
    this.nodes = new WatchArena(account);
    this.edges = new WatchArena(account);
    this.names = new WatchNames(account);
    this.identities = new WatchIdIndex(account);
    this.entryKeys = new WatchIdIndex(account);
  }
  resources() {
    return {
      nodes: this.nodeCount,
      edges: this.edgeCount,
      nodeCapacityBytes: this.nodes.capacity,
      edgeCapacityBytes: this.edges.capacity,
      ...this.names.resources(),
      ...this.identities.resources(),
      edgeBuckets: this.entryKeys.resources().buckets,
    };
  }
  private live(): void {
    if (this.stopped || this.account.closed) throw new FilesystemError(11, "watch index closed");
  }
  slot(id: bigint): number {
    this.live();
    return this.node(id) / NODE_BYTES + 1;
  }
  id(slot: number): bigint {
    this.live();
    return watchId(this.nodes.view, (slot - 1) * NODE_BYTES);
  }
  watchHead(id: bigint): number {
    this.live();
    return this.nodes.view.getUint32(this.node(id) + 28, true);
  }
  setWatchHead(id: bigint, slot: number): void {
    this.live();
    this.nodes.view.setUint32(this.node(id) + 28, slot, true);
  }
  private node(id: bigint): number {
    const slot = this.identities.get(id);
    if (!slot) throw new Error("watch identity not indexed");
    return (slot - 1) * NODE_BYTES;
  }
  has(id: bigint): boolean {
    this.live();
    return this.identities.get(id) !== 0;
  }
  upsert(id: bigint, mode: number, directory: boolean): void {
    this.live();
    identity(id);
    const prior = this.identities.get(id);
    if (prior) {
      this.nodes.view.setUint32(
        (prior - 1) * NODE_BYTES + 16,
        mode | (directory ? DIRECTORY : 0),
        true,
      );
      return;
    }
    const slot = this.freeNode || this.nodeTail + 1;
    const growth = this.nodes.stage(slot * NODE_BYTES);
    try {
      const rehash = this.identities.stage();
      growth.commit();
      rehash.commit();
    } catch (error) {
      growth.cancel();
      throw error;
    }
    const at = (slot - 1) * NODE_BYTES;
    if (this.freeNode) this.freeNode = this.nodes.view.getUint32(at + INCOMING, true);
    else this.nodeTail++;
    this.nodes.bytes.fill(0, at, at + NODE_BYTES);
    setWatchId(this.nodes.view, at, id);
    this.nodes.view.setUint32(at + 16, mode | (directory ? DIRECTORY : 0), true);
    this.identities.add(id, slot);
    this.nodeCount++;
  }
  setRoot(id: bigint): void {
    this.live();
    if (this.root && this.root !== id) throw new Error("watch root already selected");
    this.node(id);
    this.root = id;
  }
  metadata(id: bigint): { mode: number; directory: boolean; links: number; pins: number } {
    this.live();
    const at = this.node(id);
    const word = this.nodes.view.getUint32(at + 16, true);
    return {
      mode: word & 0xffff,
      directory: !!(word & DIRECTORY),
      links: this.nodes.view.getUint32(at + LINKS, true),
      pins: this.nodes.view.getUint32(at + PINS, true),
    };
  }
  pin(id: bigint): void {
    this.live();
    const at = this.node(id) + PINS;
    const count = this.nodes.view.getUint32(at, true);
    if (count === 0xffffffff) throw new FilesystemError(6, "watch pin representation exhausted");
    this.nodes.view.setUint32(at, count + 1, true);
  }
  unpin(id: bigint): void {
    this.live();
    const at = this.node(id) + PINS;
    const count = this.nodes.view.getUint32(at, true);
    if (!count) throw new Error("watch identity has no pin");
    this.nodes.view.setUint32(at, count - 1, true);
    this.collect(id);
  }
  link(parent: bigint, child: bigint, name: string): void {
    this.live();
    const parentAt = this.node(parent);
    const childAt = this.node(child);
    if (!(this.nodes.view.getUint32(parentAt + 16, true) & DIRECTORY))
      throw new Error("watch edge parent is not a directory");
    const existing = this.findEdge(parentAt, name);
    if (existing) {
      if (
        this.edges.view.getUint32((existing - 1) * EDGE_BYTES + 4, true) !==
        childAt / NODE_BYTES + 1
      )
        throw new Error("watch edge replacement requires unlink");
      return;
    }
    const slot = this.freeEdge || this.edgeTail + 1;
    const growth = this.edges.stage(slot * EDGE_BYTES);
    let stored: WatchNameReservation | undefined;
    let lookup: WatchGrowth | undefined;
    try {
      stored = this.names.stage(name);
      lookup = this.entryKeys.stage();
      growth.commit();
      const offset = stored.commit();
      lookup.commit();
      this.insertEdge(slot, parentAt, childAt, offset, stored.length);
      this.entryKeys.add(edgeKey(parentAt, name), slot);
    } catch (error) {
      growth.cancel();
      stored?.cancel();
      lookup?.cancel();
      throw error;
    }
  }

  private insertEdge(
    slot: number,
    parent: number,
    child: number,
    name: number,
    length: number,
  ): void {
    const view = this.edges.view;
    const at = (slot - 1) * EDGE_BYTES;
    if (this.freeEdge) this.freeEdge = view.getUint32(at, true);
    else this.edgeTail++;
    const incoming = this.nodes.view.getUint32(child + INCOMING, true);
    const outgoing = this.nodes.view.getUint32(parent + OUTGOING, true);
    view.setUint32(at, parent / NODE_BYTES + 1, true);
    view.setUint32(at + 4, child / NODE_BYTES + 1, true);
    view.setUint32(at + 8, 0, true);
    view.setUint32(at + 12, incoming, true);
    view.setUint32(at + 16, 0, true);
    view.setUint32(at + 20, outgoing, true);
    view.setUint32(at + 24, name, true);
    view.setUint32(at + 28, length, true);
    if (incoming) view.setUint32((incoming - 1) * EDGE_BYTES + 8, slot, true);
    if (outgoing) view.setUint32((outgoing - 1) * EDGE_BYTES + 16, slot, true);
    this.nodes.view.setUint32(child + INCOMING, slot, true);
    this.nodes.view.setUint32(parent + OUTGOING, slot, true);
    const links = this.nodes.view.getUint32(child + LINKS, true);
    this.nodes.view.setUint32(child + LINKS, links + 1, true);
    this.edgeCount++;
  }
  private findEdge(parent: number, name: string): number {
    return this.entryKeys.get(edgeKey(parent, name), (slot) => {
      const at = (slot - 1) * EDGE_BYTES;
      return (
        this.names.read(
          this.edges.view.getUint32(at + 24, true),
          this.edges.view.getUint32(at + 28, true),
        ) === name
      );
    });
  }

  unlink(parent: bigint, name: string): bigint | undefined {
    this.live();
    const parentAt = this.node(parent);
    const slot = this.findEdge(parentAt, name);
    if (!slot) return;
    const at = (slot - 1) * EDGE_BYTES;
    const view = this.edges.view;
    const child = (view.getUint32(at + 4, true) - 1) * NODE_BYTES;
    const id = watchId(this.nodes.view, child);
    this.entryKeys.delete(edgeKey(parentAt, name), (candidate) => candidate === slot);
    this.detach(slot, child, INCOMING, 8, 12);
    this.detach(slot, parentAt, OUTGOING, 16, 20);
    this.names.release(view.getUint32(at + 24, true), view.getUint32(at + 28, true));
    this.nodes.view.setUint32(
      child + LINKS,
      this.nodes.view.getUint32(child + LINKS, true) - 1,
      true,
    );
    this.edges.bytes.fill(0, at, at + EDGE_BYTES);
    view.setUint32(at, this.freeEdge, true);
    this.freeEdge = slot;
    this.edgeCount--;
    return id;
  }
  private detach(
    slot: number,
    node: number,
    head: number,
    previousWord: number,
    nextWord: number,
  ): void {
    const view = this.edges.view;
    const at = (slot - 1) * EDGE_BYTES;
    const previous = view.getUint32(at + previousWord, true);
    const next = view.getUint32(at + nextWord, true);
    if (previous) view.setUint32((previous - 1) * EDGE_BYTES + nextWord, next, true);
    else this.nodes.view.setUint32(node + head, next, true);
    if (next) view.setUint32((next - 1) * EDGE_BYTES + previousWord, previous, true);
  }
  forEachParent(id: bigint, visit: (parent: bigint, name: string) => void): void {
    this.live();
    const at = this.node(id);
    for (
      let slot = this.nodes.view.getUint32(at + INCOMING, true);
      slot;
      slot = this.edges.view.getUint32((slot - 1) * EDGE_BYTES + 12, true)
    ) {
      const edge = (slot - 1) * EDGE_BYTES;
      const parent = (this.edges.view.getUint32(edge, true) - 1) * NODE_BYTES;
      visit(
        watchId(this.nodes.view, parent),
        this.names.read(
          this.edges.view.getUint32(edge + 24, true),
          this.edges.view.getUint32(edge + 28, true),
        ),
      );
    }
  }
  collect(id: bigint): void {
    this.live();
    if (!this.has(id) || id === this.root) return;
    const at = this.node(id);
    const view = this.nodes.view;
    if (
      view.getUint32(at + INCOMING, true) ||
      view.getUint32(at + OUTGOING, true) ||
      view.getUint32(at + PINS, true)
    )
      return;
    this.identities.delete(id);
    this.nodes.bytes.fill(0, at, at + NODE_BYTES);
    view.setUint32(at + INCOMING, this.freeNode, true);
    this.freeNode = at / NODE_BYTES + 1;
    this.nodeCount--;
  }
  clear(): void {
    this.names.close();
    this.identities.close();
    this.entryKeys.close();
    this.edges.close();
    this.nodes.close();
    this.root = 0n;
    this.nodeCount = this.edgeCount = 0;
    this.nodeTail = this.edgeTail = this.freeNode = this.freeEdge = 0;
  }
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clear();
  }
}
