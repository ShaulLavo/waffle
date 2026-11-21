import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { captureMethod, captureExperimentFile } from "./capture-hooks.js";
import { installIndexedDB } from "./indexeddb-hooks.js";

const root = process.argv[2];
if (!root) throw new Error("Pass the disposable package source directory");

export class Source {
  constructor(
    readonly name: string,
    private text: string,
  ) {}

  replace(before: string, after: string): void {
    const at = this.text.indexOf(before);
    if (at < 0 || this.text.indexOf(before, at + before.length) >= 0)
      throw new Error(`Expected one anchor in ${this.name}: ${before}`);
    this.text = this.text.slice(0, at) + after + this.text.slice(at + before.length);
  }

  section(start: string, end: string, edit: (section: Source) => void): void {
    const at = this.text.indexOf(start);
    const stop = this.text.indexOf(end, at + start.length);
    if (at < 0 || stop < 0) throw new Error(`Missing section in ${this.name}: ${start}`);
    const previous = this.text.slice(at, stop);
    const section = new Source(start, previous);
    edit(section);
    this.replace(previous, section.text);
  }

  write(): Promise<void> {
    return writeFile(resolve(root!, this.name), this.text);
  }
}

async function edit(name: string, change: (file: Source) => void): Promise<void> {
  const file = new Source(name, await readFile(resolve(root!, name), "utf8"));
  change(file);
  await file.write();
}

await Promise.all([
  copyFile(resolve(import.meta.dir, "mutations.ts"), resolve(root, "fs/checkpoint-mutations.ts")),
  copyFile(resolve(import.meta.dir, "chunk-map.ts"), resolve(root, "fs/checkpoint-map.ts")),
  edit("tooling/vfs-benchmark.ts", (file) =>
    file.replace('"waffle-vfs-checkpoint-baseline"', '"waffle-vfs-checkpoint-incremental"'),
  ),
  edit("tooling/vfs-browser.ts", (file) => {
    file.replace(
      "    return { reopenedGeneration: index.generation, reopenedPayload: file.data, verifiedBytes: size };",
      `    const map = storage.experimentDifference("checkpoint-seed", file.data);
    if (map.reused !== 1023 || map.newNodes !== 2) throw new Error("Reopened chunk map has unexpected sharing");
    return { reopenedGeneration: index.generation, reopenedPayload: file.data, verifiedBytes: size, reopenedMap: map };`,
    );
  }),
  edit("browser/filesystem-backend.ts", (file) =>
    file.replace('"waffle-vfs-checkpoint-baseline"', '"waffle-vfs-checkpoint-incremental"'),
  ),
  edit("fs/storage-geometry.ts", (file) => {
    file.replace(
      "export const SHARED_ROOT_BYTES = DATA_OFFSET + SHARED_SEGMENT_BYTES;",
      `export const EXPERIMENT_MUTATION_OFFSET = DATA_OFFSET + SHARED_SEGMENT_BYTES;
export const SHARED_ROOT_BYTES = EXPERIMENT_MUTATION_OFFSET + (2 + 2048 * 8) * 4;`,
    );
  }),
  edit("fs/shared.ts", (file) => {
    file.replace(
      "import { WatchRing }",
      'import { CHUNK_SIZE } from "./indexeddb-chunks.js";\nimport { MutationLog, dirtyChunks, type CaptureDelta } from "./checkpoint-mutations.js";\nimport { WatchRing }',
    );
    file.replace("  SHARED_ROOT_BYTES,", "  SHARED_ROOT_BYTES,\n  EXPERIMENT_MUTATION_OFFSET,");
    file.replace(
      "  readonly dirtyAdmission:",
      `  readonly checkpointMutations: MutationLog;
  experimentAfterFirstCopy?: () => void;
  experimentBeforeUnlock?: () => void;
  experimentAfterStage?: () => void;
  readonly dirtyAdmission:`,
    );
    file.replace(
      "    buffer = this.buffer;",
      "    buffer = this.buffer;\n    this.checkpointMutations = new MutationLog(buffer, EXPERIMENT_MUTATION_OFFSET);",
    );

    file.section("  private direct(", "  private prepareDirectPublication(", (method) => {
      method.replace(
        "          identity,\n        );\n        return end;",
        "          identity,\n          owner,\n        );\n        return end;",
      );
      method.replace(
        "    identity?: PlannedIdentityRevision,",
        "    identity: PlannedIdentityRevision | undefined,\n    owner: number,",
      );
      method.replace(
        "    publication?: PreparedPublication,",
        "    publication: PreparedPublication | undefined,",
      );
      method.replace(
        "      this.copyChunks(slot, chunks, at);",
        `      const mutation = this.checkpointMutations.reserve(owner, this.slots[base + HANDLE]! - 1, {
        kind: "write", start: at, end,
      });
      this.copyChunks(slot, chunks, at);
      this.experimentAfterFirstCopy?.();`,
      );
      method.replace(
        "      if (publication) this.publication!.commit(publication);",
        "      if (publication) this.publication!.commit(publication);\n      this.checkpointMutations.settle(mutation, this.getRevision(slot));",
      );
    });
    file.section("  commitStagedWrite(", "  stageWrite(", (method) => {
      method.replace(
        "        Atomics.store(cells, STAGE_POSITION, at);",
        `        const mutation = this.checkpointMutations.reserve(owner, handle, { kind: "stage", start: at, end });
        Atomics.store(cells, STAGE_POSITION, at);`,
      );
      method.replace(
        "          State.Complete\n        )\n          return undefined;",
        `          State.Complete
        ) {
          this.checkpointMutations.cancel(mutation);
          return undefined;
        }`,
      );
    });
    file.section(
      "  private applyStaged(",
      "  /** Caller owns the global mutation lock.",
      (method) => {
        method.replace(
          "    slots[base + REVISION_STATE] = slots[base + REVISION_STATE]! | RESIDENT;",
          `    slots[base + REVISION_STATE] = slots[base + REVISION_STATE]! | RESIDENT;
    this.checkpointMutations.settleStage(stage.handle, this.getRevision(stage.slot));
    this.experimentAfterStage?.();`,
        );
      },
    );
    for (const [start, end] of [
      ["  tryWrite(", "  write("],
      ["  tryAppend(", "  append("],
    ]) {
      file.section(start!, end!, (method) => {
        method.replace(
          "      let at = offset;",
          `      const mutation = this.checkpointMutations.reserve(owner, handle, {
        kind: "write", start: offset, end: offset + total,
      });
      let at = offset;`,
        );
        method.replace(
          "      this.commitIdentityVersion(slot, identity);",
          "      this.commitIdentityVersion(slot, identity);\n      this.checkpointMutations.settle(mutation, this.getRevision(slot));",
        );
      });
    }
    file.section("  resize(", "  private zeroTruncatedPages(", (method) => {
      method.replace(
        "      if (resident && truncate && size < old) this.zeroTruncatedPages(slot, size, old);",
        `      const mutation = truncate || next !== old
        ? this.checkpointMutations.reserve(owner, handle, { kind: "resize", start: old, end: next })
        : undefined;
      if (resident && truncate && size < old) this.zeroTruncatedPages(slot, size, old);`,
      );
      method.replace(
        "      if (publication) this.publication!.commit(publication);",
        `      if (publication) this.publication!.commit(publication);
      if (mutation !== undefined) this.checkpointMutations.settle(mutation, this.getRevision(slot));`,
      );
    });
    file.replace(
      "    for (let slot = 1; slot < MAX_FILES; slot++)\n      Atomics.compareExchange(this.slots, this.at(slot, FILE_LOCK), owner, 0);",
      `    if (ownsGlobal) {
      this.checkpointMutations.beforeUnlock(owner, (handle) => {
        const slot = this.findSlot(handle);
        return !!slot && Atomics.load(this.slots, this.at(slot, FILE_LOCK)) === owner;
      });
      this.experimentBeforeUnlock?.();
    }
    for (let slot = 1; slot < MAX_FILES; slot++)
      Atomics.compareExchange(this.slots, this.at(slot, FILE_LOCK), owner, 0);`,
    );
    file.replace("  /** Eviction may discard", `${captureMethod}\n  /** Eviction may discard`);
    file.replace(
      "  revokeOwner(owner:",
      `  experimentFileOwner(handle: FileHandle): number {
    return Atomics.load(this.slots, this.at(this.fileSlot(handle), FILE_LOCK));
  }
  revokeOwner(owner:`,
    );
  }),
  edit("fs/storage.ts", (file) => {
    file.replace(
      "export interface PersistenceBatch {",
      `export interface PersistenceBatch {
  experiment?: import("./checkpoint-mutations.js").CheckpointCut;`,
    );
    file.replace(
      "    data: new Map(Array.from(batch.data,",
      "    experiment: batch.experiment,\n    data: new Map(Array.from(batch.data,",
    );
    file.replace(
      "export interface StorageBackend {",
      `export interface StorageBackend {
  readonly experimentHead?: string;
  readonly experimentAvailable?: boolean;`,
    );
  }),
  edit("fs/persistent.ts", (file) => {
    file.section("  private pruneDetached(", "  private retainedData(", (method) => {
      method.replace(
        "    for (const [handle, node]",
        "    const unreachable = new Map<FileHandle, number>();\n    for (const [handle, node]",
      );
      method.replace(
        "          this.keys.delete(node.ino);",
        "          unreachable.set(handle, Infinity);\n          this.keys.delete(node.ino);",
      );
      method.replace(
        "      }\n  }",
        `      }
    if (unreachable.size) this.shared.mutate(undefined, undefined, () => this.shared.checkpointMutations.confirm(unreachable));
  }`,
      );
    });
    file.replace(
      "import { restoreTree }",
      'import type { CaptureDelta, CheckpointCut } from "./checkpoint-mutations.js";\nimport { ExperimentUnconfirmed } from "./checkpoint-map.js";\nimport { restoreTree }',
    );
    file.replace(
      "interface CheckpointCapture {",
      `interface CheckpointCapture {
  deltas: Map<string, CaptureDelta>;
  confirmed: Map<FileHandle, number>;`,
    );
    file.replace(
      "  private checkpointEpoch:",
      `  private experimentHead: string | undefined;
  private experimentRecovering = false;
  private experimentUnconfirmed = false;
  private readonly experimentDetached = new Map<FileHandle, { key: string; revision: number }>();
  experimentOnCapture?: (cut: CheckpointCut) => void;
  private checkpointEpoch:`,
    );
    file.replace(
      "    this.configureDirty();",
      "    this.configureDirty();\n    this.experimentHead = storage.experimentHead;",
    );
    file.replace(
      "      if (this.shared.isResident(handle)) bytes += (this.shared.stat(handle)?.size ?? 0) * 2;",
      `      if (this.storage.experimentAvailable) {
        const pending = this.experimentDetached.get(handle);
        const parent = pending?.key ?? this.keys.get(node.ino) ?? this.detachedKeys.get(node.ino);
        bytes += this.shared.checkpointFile(handle, pending?.revision ?? this.revisions.get(handle), parent, false)?.bytes ?? 0;
      } else if (this.shared.isResident(handle)) bytes += (this.shared.stat(handle)?.size ?? 0) * 2;`,
    );
    file.replace(
      "      const selected =\n",
      `      this.shared.checkpointMutations.assertLive();
      if (this.experimentRecovering || this.experimentUnconfirmed) throw new Error("Checkpoint recovery is required");
      const selected =
`,
    );
    file.replace(
      "    { changed, data, detachedSnapshots }: CheckpointCapture,",
      `    capture: CheckpointCapture,`,
    );
    file.replace(
      "    const revision = this.shared.revision(handle);\n    if (revision === undefined || revision === this.revisions.get(handle)) return;\n    const node",
      `    if (this.storage.experimentAvailable) return this.captureExperimentFile(handle, durable, target, selected, capture);
    const { changed, data, detachedSnapshots } = capture;
    const revision = this.shared.revision(handle);
    if (revision === undefined || revision === this.revisions.get(handle)) return;
    const node`,
    );
    file.replace("  private persistedNode(", `${captureExperimentFile}\n  private persistedNode(`);
    file.replace(
      "      changed: new Set(this.dirty),",
      "      confirmed: new Map(),\n      deltas: new Map(),\n      changed: new Set(this.dirty),",
    );
    file.replace(
      "    const epoch = this.checkpointEpoch;",
      `    const epoch = this.checkpointEpoch;
    const experiment = this.storage.experimentAvailable
      ? { id: crypto.randomUUID(), parent: this.experimentHead, deltas: capture.deltas }
      : undefined;
    if (experiment) {
      this.experimentHead = experiment.id;
      this.experimentOnCapture?.(experiment);
    }`,
    );
    file.replace("      generation: 0,", "      experiment,\n      generation: 0,");
    file.replace(
      "        this.generation = batch.generation;",
      `        this.generation = batch.generation;
        if (experiment) this.shared.mutate(undefined, undefined, () => this.shared.checkpointMutations.confirm(capture.confirmed));`,
    );
    file.replace(
      "      this.checkpointEpoch = {};",
      `      if (this.checkpointEpoch === epoch) this.checkpointEpoch = {};
      if (experiment) {
        this.experimentDetached.clear();
        this.experimentRecovering = this.pendingCheckpoints !== 0;
        if (cause instanceof ExperimentUnconfirmed) this.experimentUnconfirmed = true;
        this.experimentHead = this.storage.experimentHead;
      }`,
    );
    file.replace(
      "      this.checkpointEpoch.failure ??= { cause };",
      "      epoch.failure ??= { cause };",
    );
    file.replace(
      '      if (node.kind === "file") this.revisions.delete(this.fs.handleForNode(node));',
      `      if (node.kind === "file") {
        const handle = this.fs.handleForNode(node);
        this.revisions.delete(handle);
        const pending = this.experimentDetached.get(handle);
        if (pending) this.keys.set(node.ino, pending.key);
      }`,
    );
    file.replace(
      "        for (const [node, snapshot] of detachedSnapshots) {",
      `        for (const [node, snapshot] of detachedSnapshots) {
          if (this.experimentDetached.get(snapshot.handle)?.key === snapshot.key)
            this.experimentDetached.delete(snapshot.handle);`,
    );
    file.replace(
      "        await this.storage.persist(batch);",
      "        this.shared.checkpointMutations.assertLive();\n        await this.storage.persist(batch);",
    );
    file.replace(
      "    try {\n      return this.captureReserved(request, reservation, cost)",
      `    const retire = () => {
      this.pressure.release(reservation);
      this.shared.mutate(undefined, undefined, () => this.shared.dirtyAdmission.releaseCopy(cost));
    };
    let uncertain: ExperimentUnconfirmed | undefined;
    try {
      return this.captureReserved(request, reservation, cost)`,
    );
    file.replace(
      `        .finally(() => {
          this.pressure.release(reservation);
          this.shared.mutate(undefined, undefined, () =>
            this.shared.dirtyAdmission.releaseCopy(cost),
          );
        });`,
      `        .catch((error: unknown) => {
          if (error instanceof ExperimentUnconfirmed) uncertain = error;
          throw error;
        })
        .finally(() => {
          if (uncertain) void uncertain.resolution.promise.then(retire);
          else retire();
        });`,
    );
  }),
  edit("fs/indexeddb.ts", installIndexedDB),
]);
