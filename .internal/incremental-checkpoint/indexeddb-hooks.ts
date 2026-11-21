import type { Source } from "./install.js";

export function installIndexedDB(file: Source): void {
  file.replace(
    "import {\n  STAGED_FORMAT,",
    'import { CheckpointMap, ExperimentUnconfirmed, FORMAT as EXPERIMENT_FORMAT, WORKSPACE as EXPERIMENT_WORKSPACE, isReceipt, sameReceipt, type ExperimentReceipt, type PreparedMap } from "./checkpoint-map.js";\nimport {\n  STAGED_FORMAT,',
  );
  file.replace(
    "    format !== INDEXEDDB_FORMAT &&",
    "    format !== INDEXEDDB_FORMAT &&\n    format !== EXPERIMENT_FORMAT &&",
  );
  file.replace(
    "  if (keys.some((key) => !allowed.includes(key)))",
    '  if (keys.some((key) => !allowed.includes(key) && !(typeof key === "string" && key.startsWith("experiment-"))))',
  );
  file.replace(
    "  private readOnlyLegacy = false;",
    `  private readOnlyLegacy = false;
  private readonly experimentMap = new CheckpointMap();
  private experimentRetained: readonly string[] = [];
  private readonly experimentPins = new Map<string, number>();
  private recoveredExperimentHead: string | undefined;
  experimentBeforeTransaction?: (receipt: ExperimentReceipt) => Promise<"commit" | "abort" | "lose-ack" | "stop">;
  get experimentAvailable(): boolean {
    return this.db.name === EXPERIMENT_WORKSPACE && !this.committedMode;
  }
  get experimentHead(): string | undefined {
    return this.recoveredExperimentHead;
  }
`,
  );
  file.replace(
    '        request(metadata.get("active")),',
    '        request(metadata.get("active")),\n        request(metadata.get("experiment-head")),',
  );
  file.replace(
    "      active,\n    ] = await this.indexRecords(signal);",
    "      active,\n      experimentHead,\n    ] = await this.indexRecords(signal);",
  );
  file.replace(
    "    const stagedEmpty = validateDatabaseLayout(",
    `    if (this.experimentAvailable && format !== undefined && format !== EXPERIMENT_FORMAT)
      throw new Error("Unexpected format in private checkpoint database");
    if (!this.experimentAvailable && format === EXPERIMENT_FORMAT)
      throw new Error("Checkpoint experiment database name mismatch");
    const stagedEmpty = validateDatabaseLayout(`,
  );
  file.replace(
    '      else if (Array.isArray(key) && typeof key[0] === "string") payloadKeys.add(key[0]);',
    '      else if (!this.experimentAvailable && Array.isArray(key) && typeof key[0] === "string") payloadKeys.add(key[0]);',
  );
  file.replace(
    "      format === INDEXEDDB_FORMAT || format === STAGED_FORMAT",
    `      this.experimentAvailable
        ? new Map(Array.from(await this.experimentMap.recover(dataKeys, (key) => this.readRecord(key, signal)),
            ([key, size]) => [key, { version: 2 as const, size, chunkSize: CHUNK_SIZE, count: Math.ceil(size / CHUNK_SIZE) }]))
        : format === INDEXEDDB_FORMAT || format === STAGED_FORMAT`,
  );
  file.replace(
    "    this.readOnlyLegacy = this.readOnly && format !== INDEXEDDB_FORMAT;",
    `    if (this.experimentAvailable) {
      this.recoveredExperimentHead = await this.findExperimentHead(experimentHead, newest?.generation);
      if (format === undefined || this.recoveredExperimentHead !== experimentHead) await this.fencedWrite((_data, metadata) => {
        metadata.put(EXPERIMENT_FORMAT, "format");
        if (this.recoveredExperimentHead && newest) {
          metadata.put(this.recoveredExperimentHead, "experiment-head");
          metadata.put(newest.generation, "active");
        }
      }, signal);
    }
    this.readOnlyLegacy = this.readOnly && format !== INDEXEDDB_FORMAT && !this.experimentAvailable;`,
  );
  file.replace(
    "    if (!this.readOnly && !this.committedMode && format !== INDEXEDDB_FORMAT)",
    "    if (!this.experimentAvailable && !this.readOnly && !this.committedMode && format !== INDEXEDDB_FORMAT)",
  );
  file.replace(
    "    const value = await this.readRecord(key, signal);\n    if (value === undefined) throw",
    `    if (this.experimentAvailable) {
      const manifest = this.experimentMap.manifests.get(key);
      if (!manifest) chunkError(key);
      return { version: 2, size: manifest.size, chunkSize: CHUNK_SIZE, count: Math.ceil(manifest.size / CHUNK_SIZE) };
    }
    const value = await this.readRecord(key, signal);
    if (value === undefined) throw`,
  );
  file.replace(
    "    if (this.payloadSize(key) !== expectedSize)",
    `    if ((this.experimentAvailable ? this.experimentMap.manifests.get(key)?.size : this.payloadSize(key)) !== expectedSize)`,
  );
  file.replace(
    "    const length = Math.max(0, Math.min(range.length, manifest.size - range.offset));",
    `    if (this.experimentAvailable)
      return this.experimentMap.read(key, range.offset, range.length, (key, signal) => this.readRecord(key, signal), range.signal);
    const length = Math.max(0, Math.min(range.length, manifest.size - range.offset));`,
  );
  file.replace("  private async commit(batch:", `${storageMethods}\n  private async commit(batch:`);
  file.replace(
    "    const prepared = await preparePayloads(batch.data);",
    `    const payloadReads = this.experimentMap.payloadReads;
    const experiment = this.experimentAvailable
      ? batch.experiment ?? { id: crypto.randomUUID(), parent: this.experimentHead, deltas: new Map() }
      : undefined;
    const experimentMaps = experiment ? await this.prepareExperimentMaps(batch, experiment) : undefined;
    const prepared = experiment ? new Map() : await preparePayloads(batch.data);`,
  );
  file.replace(
    "    const encodedSnapshot = snapshot && (await encodeSelection(snapshot));",
    `    const encodedSnapshot = snapshot && (await encodeSelection(snapshot));
    const selection = encodedJournal ?? encodedSnapshot;
    const experimentReceipt: ExperimentReceipt | undefined = experiment && selection && {
      id: experiment.id,
      parent: experiment.parent,
      generation: batch.generation,
      epoch: this.epoch,
      journal: encodedJournal?.checksum,
      base: encodedSnapshot?.checksum,
    };`,
  );
  file.replace(
    "    const deletedReaders: string[] = [];",
    `    const fault = experimentReceipt && this.experimentBeforeTransaction
      ? await this.experimentBeforeTransaction(experimentReceipt) : "commit";
    if (fault === "stop") throw new Error("Stopped before checkpoint transaction");
    const deletedReaders: string[] = [];`,
  );
  file.replace(
    '    const data = tx.objectStore("data");\n    await new Promise<void>',
    `    const data = tx.objectStore("data");
    const transactionStart = performance.now();
    await new Promise<void>`,
  );
  file.replace(
    '          tx.objectStore("metadata").put(batch.generation, "active");',
    `          tx.objectStore("metadata").put(batch.generation, "active");
          if (experimentReceipt) {
            const metadata = tx.objectStore("metadata");
            metadata.add(experimentReceipt, "experiment-receipt:" + experimentReceipt.id);
            metadata.put(experimentReceipt.id, "experiment-head");
          }`,
  );
  file.replace(
    "              if (!retained.has(key) && !this.readers.has(key)) {",
    "              if (!experiment && !retained.has(key) && !this.readers.has(key)) {",
  );
  file.replace(
    "        } catch (error) {\n          abort(error);\n        }\n      };\n      let remaining = checking.size",
    `          if (fault === "abort") throw new Error("Injected checkpoint transaction abort");
        } catch (error) {
          abort(error);
        }
      };
      let remaining = checking.size`,
  );
  file.replace(
    "      let remaining = checking.size + pinChecks.size + (committed ? 2 : 0);",
    "      let remaining = checking.size + pinChecks.size + (committed ? 2 : 0) + (experiment ? 2 : 0);",
  );
  file.replace(
    "        if (committed) checked();",
    "        if (committed || experiment) checked();",
  );
  file.replace(
    "      if (committed) checkCommitHead",
    `      if (experiment) {
        const parent = tx.objectStore("metadata").get("experiment-head");
        parent.onsuccess = () => {
          if (parent.result === experiment.parent) checked();
          else abort(new Error("Checkpoint predecessor changed"));
        };
      }
      if (committed) checkCommitHead`,
  );
  file.replace(
    "              checkPayload(\n",
    `              if (experimentMaps) {
                const map = experimentMaps.get(key);
                if (map) {
                  if (get.result !== undefined || (expected.has(key) && expected.get(key) !== map.manifest.size))
                    throw new Error("Invalid immutable checkpoint map: " + key);
                  this.experimentMap.put(data, key, map);
                } else if (get.result === undefined || this.experimentMap.manifests.get(key)?.size !== expected.get(key)) {
                  throw new Error("Missing checkpoint map: " + key);
                }
                checked();
                return;
              }
              checkPayload(
`,
  );
  file.replace(
    "    const state: State = old ?? {",
    `    const transactionMs = performance.now() - transactionStart;
    if (fault === "lose-ack" && experimentReceipt) {
      this.loseOwnership();
      throw new ExperimentUnconfirmed(experimentReceipt);
    }
    const installStart = performance.now();
    if (experiment && experimentMaps) {
      this.recoveredExperimentHead = experiment.id;
      for (const [key, map] of experimentMaps) this.experimentMap.install(key, map);
    }
    const state: State = old ?? {`,
  );
  file.replace(
    "        state.payloadKeys.delete(key);",
    "        state.payloadKeys.delete(key);\n        this.experimentMap.manifests.delete(key);",
  );
  file.replace(
    "    this.recordRecovery(state, retained);",
    "    this.recordRecovery(state, retained);\n    if (this.experimentAvailable) this.experimentRetained = retained;",
  );
  file.replace(
    "      committed,\n    );\n  }\n  private installCommit",
    `      committed,
    );
    if (experiment && experimentMaps) for (const [key, map] of experimentMaps) {
      console.log("CHECKPOINT_PROBE " + JSON.stringify({
        ...map.metrics,
        payloadReads: this.experimentMap.payloadReads - payloadReads,
        key,
        checkpointId: experiment.id,
        parentCheckpointId: experiment.parent,
        payloadBytesHashed: map.metrics.copied,
        payloadBytesCommitted: map.metrics.copied,
        chunkPuts: map.chunks.size,
        mapPuts: map.nodes.size,
        manifestPuts: 1,
        mapMetadataJsonBytes: new TextEncoder().encode(JSON.stringify([map.manifest, Array.from(map.nodes)])).byteLength,
        namespaceBytes: new TextEncoder().encode(selection?.json).byteLength,
        namespacePuts: Number(!!encodedJournal) + Number(!!encodedSnapshot),
        transactionMs,
        installMs: performance.now() - installStart,
        durability: tx.durability,
      }));
    }
  }
  private installCommit`,
  );
}

const storageMethods = `
  experimentChunkKey(key: string, index: number): IDBValidKey | undefined {
    return this.experimentMap.chunkKey(key, index);
  }

  experimentDifference(before: string, after: string) {
    return this.experimentMap.difference(before, after);
  }

  private receiptKey(id: string): string {
    return "experiment-receipt:" + id;
  }

  private async receipt(metadata: IDBObjectStore, id: string): Promise<ExperimentReceipt> {
    const value: unknown = await request(metadata.get(this.receiptKey(id)));
    if (!isReceipt(value) || value.id !== id || value.epoch > this.epoch)
      throw new Error("Invalid checkpoint receipt chain");
    return value;
  }

  private async findExperimentHead(head: unknown, generation: number | undefined): Promise<string | undefined> {
    if (generation === undefined) return;
    if (typeof head !== "string") throw new Error("Missing checkpoint head receipt");
    const tx = this.db.transaction(["metadata", "journal"]);
    const metadata = tx.objectStore("metadata");
    let id: string | undefined = head;
    let previous = Infinity;
    while (id !== undefined) {
      const receipt = await this.receipt(metadata, id);
      if (receipt.generation >= previous) throw new Error("Invalid checkpoint receipt order");
      if (receipt.generation === generation) {
        await this.checkExperimentSelection(tx, receipt);
        return id;
      }
      previous = receipt.generation;
      id = receipt.parent;
    }
    throw new Error("Checkpoint root has no receipt");
  }

  private async checkExperimentSelection(tx: IDBTransaction, receipt: ExperimentReceipt): Promise<void> {
    const metadata = tx.objectStore("metadata");
    const records: unknown[] = await Promise.all([
      request(tx.objectStore("journal").get(receipt.generation)),
      request(metadata.get(0)), request(metadata.get(1)),
    ]);
    if (!records.some((value, index) => value && typeof value === "object" && "checksum" in value && typeof value.checksum === "string" &&
      value.checksum === (index === 0 ? receipt.journal : receipt.base)))
      throw new Error("Checkpoint selection does not match its receipt");
  }

  async experimentOutcome(expected: ExperimentReceipt): Promise<"committed" | "aborted"> {
    await this.load();
    this.assertOwner();
    if (!this.experimentAvailable || expected.epoch >= this.epoch)
      throw new Error("Reconciliation requires a replacement writer epoch");
    const tx = this.db.transaction(["metadata", "journal"]);
    const metadata = tx.objectStore("metadata");
    let id = this.experimentHead;
    let previous = Infinity;
    while (id !== undefined) {
      const receipt = await this.receipt(metadata, id);
      if (receipt.generation >= previous) throw new Error("Invalid checkpoint receipt order");
      if (receipt.id === expected.id) {
        if (!sameReceipt(receipt, expected)) throw new Error("Checkpoint receipt differs from frozen cut");
        if (receipt.id === this.experimentHead) await this.checkExperimentSelection(tx, receipt);
        return "committed";
      }
      if (receipt.id === expected.parent && expected.generation === receipt.generation + 1)
        break;
      previous = receipt.generation;
      id = receipt.parent;
    }
    const found: unknown = await request(metadata.get(this.receiptKey(expected.id)));
    if (found !== undefined || id !== expected.parent) throw new Error("Checkpoint outcome remains unconfirmed");
    return "aborted";
  }

  async reconcileExperiment(failure: ExperimentUnconfirmed): Promise<"committed" | "aborted"> {
    const outcome = await this.experimentOutcome(failure.receipt);
    failure.resolution.resolve();
    return outcome;
  }

  experimentReference(key: string): () => void {
    this.assertOwner();
    if (this.deletingPayloads.has(key) || !this.experimentMap.manifests.has(key))
      throw new Error("Checkpoint manifest is unavailable for a new reference");
    this.experimentPins.set(key, (this.experimentPins.get(key) ?? 0) + 1);
    return () => {
      const count = this.experimentPins.get(key) ?? 0;
      if (count <= 1) this.experimentPins.delete(key);
      else this.experimentPins.set(key, count - 1);
    };
  }

  private experimentRoots(): Set<string> {
    const roots = new Set(this.experimentRetained.concat(Array.from(this.experimentPins.keys())));
    const state = this.state;
    if (state) {
      payloads(state.nodes.values(), roots);
      for (const base of state.bases) if (base) payloads(base.nodes, roots);
      for (const journal of state.journals.values()) payloads(journal.upserts, roots);
    }
    for (const key of this.experimentMap.manifests.keys()) if (this.readers.has(key)) roots.add(key);
    return roots;
  }

  async collectExperiment(hooks: {
    afterMark?: (keys: readonly IDBValidKey[]) => void;
    beforeComplete?: (keys: readonly IDBValidKey[]) => void;
    afterNativeDelete?: (keys: readonly IDBValidKey[]) => void;
  } = {}): Promise<{ marked: number; deleted: number; markMs: number; reclaimMs: number }> {
    return this.enqueue(async () => {
      await this.initialize();
      if (!this.experimentAvailable) throw new Error("Checkpoint collection needs a private experiment database");
      const start = performance.now();
      const keys = await request(this.db.transaction("data").objectStore("data").getAllKeys());
      const marked = this.experimentMap.deletions(keys, this.experimentRoots());
      const markMs = performance.now() - start;
      hooks.afterMark?.(marked);
      let deleting: IDBValidKey[] = [];
      const begin = performance.now();
      try {
        await this.fencedWrite((data) => {
          deleting = this.experimentMap.deletions(marked, this.experimentRoots());
          for (const key of deleting) {
            if (typeof key === "string") this.deletingPayloads.add(key);
          }
          this.scheduleExperimentDeletion(data, deleting, hooks);
        });
        this.experimentMap.deleted(deleting);
        for (const key of deleting) {
          if (typeof key !== "string") continue;
          this.state?.payloadKeys.delete(key);
          this.readers.deleted(key);
        }
      } finally {
        for (const key of deleting) if (typeof key === "string") this.deletingPayloads.delete(key);
      }
      return { marked: marked.length, deleted: deleting.length, markMs, reclaimMs: performance.now() - begin };
    });
  }

  private scheduleExperimentDeletion(data: IDBObjectStore, deleting: IDBValidKey[], hooks: {
    beforeComplete?: (keys: readonly IDBValidKey[]) => void;
    afterNativeDelete?: (keys: readonly IDBValidKey[]) => void;
  }): void {
    let last: IDBRequest<undefined> | undefined;
    for (const key of deleting) last = data.delete(key);
    if (last) last.onsuccess = () => {
      try { hooks.afterNativeDelete?.(deleting); } catch { data.transaction.abort(); }
    };
    hooks.beforeComplete?.(deleting);
  }

  private async prepareExperimentMaps(
    batch: PersistenceBatch,
    cut: NonNullable<PersistenceBatch["experiment"]>,
  ): Promise<Map<string, PreparedMap>> {
    const maps = new Map<string, PreparedMap>();
    for (const [key, bytes] of batch.data) {
      const delta = cut.deltas.get(key);
      if (delta) {
        maps.set(key, await this.experimentMap.prepare(delta));
        continue;
      }
      if (batch.generation !== 1) throw new Error("Checkpoint is missing a captured payload");
      const chunks = new Map<number, Uint8Array<ArrayBuffer>>();
      for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE)
        chunks.set(offset / CHUNK_SIZE, bytes.slice(offset, offset + CHUNK_SIZE));
      maps.set(key, await this.experimentMap.prepare({
        parent: undefined, size: bytes.length, inheritedEnd: 0, chunks, discoveryMs: 0, copyMs: 0,
      }));
    }
    return maps;
  }
`;
