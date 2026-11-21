export const captureMethod = `
  checkpointFile(handle: FileHandle, after: number | undefined, parent: string | undefined, copy: boolean) {
    const slot = this.findSlot(handle);
    if (!slot) return;
    this.lock(this.at(slot, FILE_LOCK));
    try {
      const base = slot * SLOT_WORDS;
      if (this.slots[base + HANDLE] !== handle + 1 || this.slots[base] !== 1) return;
      const revision = this.getRevision(slot);
      if (revision === after) return;
      const stat: FileStat = {
        kind: "file", ino: this.slots[base + INO]!, nlink: this.slots[base + NLINK]! >>> 0,
        size: this.slots[base + FILE_SIZE]!, atime: this.time(slot, ATIME),
        mtime: this.time(slot, MTIME), ctime: this.time(slot, CTIME), ...this.modeField(slot),
      };
      const identity = this.identity(handle);
      if (!(this.slots[base + REVISION_STATE]! & RESIDENT))
        return { stat, revision, identity, bytes: 0, delta: undefined };
      const start = performance.now();
      const effects = this.checkpointMutations.effects(handle, after ?? -1, revision);
      const { dirty, inheritedEnd } = dirtyChunks(effects);
      if (!parent && after === undefined)
        for (let index = 0; index * CHUNK_SIZE < stat.size; index++) dirty.add(index);
      const discoveryMs = performance.now() - start;
      const copyStart = performance.now();
      const chunks = new Map<number, Uint8Array<ArrayBuffer>>();
      let bytes = 0;
      for (const index of dirty) {
        const from = index * CHUNK_SIZE;
        const length = Math.min(CHUNK_SIZE, stat.size - from);
        if (length <= 0) continue;
        bytes += length;
        if (copy) chunks.set(index, this.checkpointReadChunk(slot, from, length));
      }
      const delta: CaptureDelta = {
        parent, size: stat.size, inheritedEnd, chunks, discoveryMs, copyMs: performance.now() - copyStart,
        file: { handle, stat, identity, revision },
      };
      return { stat, identity, revision, delta, bytes, hasEffects: effects.length > 0 };
    } finally {
      this.unlock(this.at(slot, FILE_LOCK));
    }
  }
  private checkpointReadChunk(slot: number, from: number, length: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += DATA_PAGE_BYTES) {
      const logical = (from + offset) / DATA_PAGE_BYTES;
      const page = this.segmentFor(this.pages[this.pageAt(slot, logical)]! - 1);
      const count = Math.min(DATA_PAGE_BYTES, length - offset);
      bytes.set(count === DATA_PAGE_BYTES ? page : page.subarray(0, count), offset);
    }
    return bytes;
  }
`;

export const captureExperimentFile = `
  private captureExperimentFile(
    handle: FileHandle,
    durable: boolean,
    target: FileHandle | string | undefined,
    selected: Node | undefined,
    { changed, data, deltas, detachedSnapshots, confirmed }: CheckpointCapture,
  ): void {
    const node = this.registeredNodes.get(handle);
    if (node?.kind !== "file") return;
    const detached = this.detached.has(node);
    if (detached && (!durable || (target !== undefined && selected !== node))) return;
    const pending = this.experimentDetached.get(handle);
    const parent = pending?.key ?? this.keys.get(node.ino) ?? this.detachedKeys.get(node.ino);
    const captured = this.shared.checkpointFile(handle, pending?.revision ?? this.revisions.get(handle), parent, true);
    if (!captured) return;
    const { stat, revision, identity, delta } = captured;
    if (!detached) {
      node.size = stat.size;
      copyTimes(node, stat);
      node.identity = identity ?? node.identity;
      this.revisions.set(handle, revision);
      changed.add(node);
    }
    if (!delta) return;
    if (parent && !captured.hasEffects) return;
    const key = \`\${this.nonce}:\${node.ino}:\${++this.sequence}\`;
    if (detached) {
      const snapshot = { handle, key, revision };
      this.experimentDetached.set(handle, snapshot);
      detachedSnapshots.set(node, snapshot);
    } else this.keys.set(node.ino, key);
    confirmed.set(handle, revision);
    deltas.set(key, delta);
    data.set(key, new Uint8Array());
  }
`;
