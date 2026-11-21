import type { Source } from "./install.js";

export function installIndexedDB(file: Source): void {
  file.replace("import {\n  STAGED_FORMAT,", 'import { CheckpointMap, FORMAT as EXPERIMENT_FORMAT, WORKSPACE as EXPERIMENT_WORKSPACE, type PreparedMap } from "./checkpoint-map.js";\nimport {\n  STAGED_FORMAT,');
  file.replace('    format !== INDEXEDDB_FORMAT &&', '    format !== INDEXEDDB_FORMAT &&\n    format !== EXPERIMENT_FORMAT &&');
  file.replace('  if (keys.some((key) => !allowed.includes(key)))', '  if (keys.some((key) => !allowed.includes(key) && !(typeof key === "string" && key.startsWith("experiment-"))))');
  file.replace("  private readOnlyLegacy = false;", `  private readOnlyLegacy = false;
  private readonly experimentMap = new CheckpointMap();
  private recoveredExperimentHead: string | undefined;
  get experimentAvailable(): boolean {
    return this.db.name === EXPERIMENT_WORKSPACE && !this.committedMode;
  }
  get experimentHead(): string | undefined {
    return this.recoveredExperimentHead;
  }
`);
  file.replace('        request(metadata.get("active")),', '        request(metadata.get("active")),\n        request(metadata.get("experiment-head")),');
  file.replace("      active,\n    ] = await this.indexRecords(signal);", "      active,\n      experimentHead,\n    ] = await this.indexRecords(signal);");
  file.replace("    const stagedEmpty = validateDatabaseLayout(", `    if (this.experimentAvailable && format !== undefined && format !== EXPERIMENT_FORMAT)
      throw new Error("Unexpected format in private checkpoint database");
    if (!this.experimentAvailable && format === EXPERIMENT_FORMAT)
      throw new Error("Checkpoint experiment database name mismatch");
    const stagedEmpty = validateDatabaseLayout(`);
  file.replace('      else if (Array.isArray(key) && typeof key[0] === "string") payloadKeys.add(key[0]);', '      else if (!this.experimentAvailable && Array.isArray(key) && typeof key[0] === "string") payloadKeys.add(key[0]);');
  file.replace("      format === INDEXEDDB_FORMAT || format === STAGED_FORMAT", `      this.experimentAvailable
        ? new Map(Array.from(await this.experimentMap.recover(dataKeys, (key) => this.readRecord(key, signal)),
            ([key, size]) => [key, { version: 2 as const, size, chunkSize: CHUNK_SIZE, count: Math.ceil(size / CHUNK_SIZE) }]))
        : format === INDEXEDDB_FORMAT || format === STAGED_FORMAT`);
  file.replace('    this.readOnlyLegacy = this.readOnly && format !== INDEXEDDB_FORMAT;', `    if (this.experimentAvailable) {
      this.recoveredExperimentHead = await this.findExperimentHead(experimentHead, newest?.generation);
      if (format === undefined) await this.fencedWrite((_data, metadata) => {
        metadata.put(EXPERIMENT_FORMAT, "format");
      }, signal);
    }
    this.readOnlyLegacy = this.readOnly && format !== INDEXEDDB_FORMAT && !this.experimentAvailable;`);
  file.replace("    if (!this.readOnly && !this.committedMode && format !== INDEXEDDB_FORMAT)", "    if (!this.experimentAvailable && !this.readOnly && !this.committedMode && format !== INDEXEDDB_FORMAT)");
  file.replace("    const value = await this.readRecord(key, signal);\n    if (value === undefined) throw", `    if (this.experimentAvailable) {
      const manifest = this.experimentMap.manifests.get(key);
      if (!manifest) chunkError(key);
      return { version: 2, size: manifest.size, chunkSize: CHUNK_SIZE, count: Math.ceil(manifest.size / CHUNK_SIZE) };
    }
    const value = await this.readRecord(key, signal);
    if (value === undefined) throw`);
  file.replace("    const length = Math.max(0, Math.min(range.length, manifest.size - range.offset));", `    if (this.experimentAvailable)
      return this.experimentMap.read(key, range.offset, range.length, (key, signal) => this.readRecord(key, signal), range.signal);
    const length = Math.max(0, Math.min(range.length, manifest.size - range.offset));`);
  file.replace("  private async commit(batch:", `${storageMethods}\n  private async commit(batch:`);
  file.replace("    const prepared = await preparePayloads(batch.data);", `    const payloadReads = this.experimentMap.payloadReads;
    const experiment = this.experimentAvailable
      ? batch.experiment ?? { id: crypto.randomUUID(), parent: this.experimentHead, deltas: new Map() }
      : undefined;
    const experimentMaps = experiment ? await this.prepareExperimentMaps(batch, experiment) : undefined;
    const prepared = experiment ? new Map() : await preparePayloads(batch.data);`);
  file.replace("    const encodedSnapshot = snapshot && (await encodeSelection(snapshot));", `    const encodedSnapshot = snapshot && (await encodeSelection(snapshot));
    const selection = encodedJournal ?? encodedSnapshot;
    const experimentReceipt = experiment && selection && {
      id: experiment.id,
      parent: experiment.parent,
      generation: batch.generation,
      selection: selection.checksum,
    };`);
  file.replace("    const data = tx.objectStore(\"data\");\n    await new Promise<void>", `    const data = tx.objectStore("data");
    const transactionStart = performance.now();
    await new Promise<void>`);
  file.replace('          tx.objectStore("metadata").put(batch.generation, "active");', `          tx.objectStore("metadata").put(batch.generation, "active");
          if (experimentReceipt) {
            const metadata = tx.objectStore("metadata");
            metadata.add(experimentReceipt, "experiment-receipt:" + experimentReceipt.id);
            metadata.put(experimentReceipt.id, "experiment-head");
          }`);
  file.replace("                deletePayload(data, key);", "                deletePayload(data, key);");
  file.replace("      let remaining = checking.size + pinChecks.size + (committed ? 2 : 0);", "      let remaining = checking.size + pinChecks.size + (committed ? 2 : 0) + (experiment ? 2 : 0);");
  file.replace("        if (committed) checked();", "        if (committed || experiment) checked();");
  file.replace("      if (committed) checkCommitHead", `      if (experiment) {
        const parent = tx.objectStore("metadata").get("experiment-head");
        parent.onsuccess = () => {
          if (parent.result === experiment.parent) checked();
          else abort(new Error("Checkpoint predecessor changed"));
        };
      }
      if (committed) checkCommitHead`);
  file.replace("              checkPayload(\n", `              if (experimentMaps) {
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
`);
  file.replace("    const state: State = old ?? {", `    const transactionMs = performance.now() - transactionStart;
    const installStart = performance.now();
    if (experiment && experimentMaps) {
      this.recoveredExperimentHead = experiment.id;
      for (const [key, map] of experimentMaps) this.experimentMap.install(key, map);
    }
    const state: State = old ?? {`);
  file.replace("        state.payloadKeys.delete(key);", "        state.payloadKeys.delete(key);\n        this.experimentMap.manifests.delete(key);");
  file.replace("      committed,\n    );\n  }\n  private installCommit", `      committed,
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
        namespaceBytes: new TextEncoder().encode(selection?.json).byteLength,
        namespacePuts: Number(!!encodedJournal) + Number(!!encodedSnapshot),
        transactionMs,
        installMs: performance.now() - installStart,
        durability: tx.durability,
      }));
    }
  }
  private installCommit`);
}

const storageMethods = `
  private async findExperimentHead(head: unknown, generation: number | undefined): Promise<string | undefined> {
    if (generation === undefined) return;
    if (typeof head !== "string") throw new Error("Missing checkpoint head receipt");
    const metadata = this.db.transaction("metadata").objectStore("metadata");
    let id: string | undefined = head;
    const visited = new Set<string>();
    while (id !== undefined && !visited.has(id)) {
      visited.add(id);
      const receipt: unknown = await request(metadata.get("experiment-receipt:" + id));
      if (!receipt || typeof receipt !== "object" || !("id" in receipt) || receipt.id !== id ||
          !("generation" in receipt) || typeof receipt.generation !== "number" ||
          !("parent" in receipt) || (receipt.parent !== undefined && typeof receipt.parent !== "string"))
        throw new Error("Invalid checkpoint receipt chain");
      if (receipt.generation === generation) return id;
      id = receipt.parent;
    }
    throw new Error("Checkpoint root has no receipt");
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
