import { maintenanceLock } from "../fs/storage-maintenance.js";
import { openIdle } from "../fs/idle-owner.js";
import type { IdleWorkspace } from "../fs/idle-workspace.js";
import { assert, type StorageContractCase } from "./storage-browser-helpers.js";
import { idle, seed, request } from "./idle-workspace-fixtures.js";
import { withStorageCleanup, type StorageAllocationHooks } from "./storage-allocation.js";

type Kind = "maintenance" | "idle";
type Lease = { release(): Promise<void> };
type PeerRequest = { kind: Kind; name: string } | { kind: "close" } | { kind: "finish" };

// The existing tests module is also the nested peer's module, in every runner.
if (globalThis.location?.hash === "#waffle-release-peer") {
  let owned: Lease | IdleWorkspace | undefined;
  globalThis.onmessage = async ({ data }: MessageEvent<PeerRequest>) => {
    try {
      if (data.kind === "finish") {
        if (owned) await closePeer(owned);
        owned = undefined;
        postMessage({ result: "finished" });
        globalThis.close();
        return;
      }
      if (data.kind === "close") {
        assert(owned, "peer owns an actual lease");
        await closePeer(owned);
        owned = undefined;
        postMessage({ result: "closed" });
        return;
      }
      const acquired =
        data.kind === "maintenance"
          ? await maintenanceLock(navigator.locks, data.name, "shared")
          : await openIdle(data.name);
      assert(typeof acquired !== "string", `peer acquisition returned ${acquired}`);
      owned = acquired;
      postMessage({ result: "held" });
    } catch (error) {
      postMessage({ error: String(error) });
    }
  };
}
function closePeer(owned: Lease | IdleWorkspace): Promise<void> {
  return "release" in owned ? owned.release() : owned.close();
}
class ReleasePeer {
  private readonly worker: Worker;
  private pending: ReturnType<typeof Promise.withResolvers<string>> | undefined;
  constructor() {
    const url = new URL(import.meta.url);
    url.hash = "waffle-release-peer";
    this.worker = new Worker(url, { type: "module" });
    this.worker.onmessage = ({ data }: MessageEvent<{ result: string; error?: string }>) => {
      if (data.error) this.pending?.reject(new Error(data.error));
      else this.pending?.resolve(data.result);
    };
    this.worker.onerror = (event) => this.pending?.reject(new Error(event.message));
  }
  async call(value: PeerRequest, expected: string): Promise<void> {
    this.pending = Promise.withResolvers<string>();
    this.worker.postMessage(value);
    assert((await this.pending.promise) === expected, `peer must report ${expected}`);
  }
  async finish(): Promise<void> {
    try {
      // This ACK joins the peer's real leases before terminating the idle Worker.
      await this.call({ kind: "finish" }, "finished");
    } finally {
      this.worker.terminate();
    }
  }
}
async function releasedTrial(peer: ReleasePeer, name: string, kind: Kind): Promise<void> {
  await peer.call({ kind, name }, "held");
  const busy =
    kind === "maintenance"
      ? await maintenanceLock(navigator.locks, name, "exclusive")
      : await openIdle(name);
  if (typeof busy !== "string") await closePeer(busy);
  assert(busy === "busy", "positive control must be busy while peer holds ownership");
  await peer.call({ kind: "close" }, "closed");
  if (kind === "maintenance") {
    const lease = await maintenanceLock(navigator.locks, name, "exclusive");
    assert(lease !== "busy", "maintenance must be immediately granted after peer release");
    await lease.release();
    return;
  }
  const reopened = await idle(name);
  await reopened.close();
}
async function releaseChain(name: string, kind: Kind, trials: number): Promise<void> {
  const peer = new ReleasePeer();
  await withStorageCleanup(
    async () => {
      if (kind === "idle") await seed(name);
      for (let trial = 0; trial < trials; trial++) await releasedTrial(peer, name, kind);
    },
    async () => {
      await withStorageCleanup(
        () => peer.finish(),
        async () => {
          if (kind === "idle") await request(indexedDB.deleteDatabase(name));
        },
      );
    },
  );
}
export function storageReleaseCases(allocation?: StorageAllocationHooks): StorageContractCase[] {
  return (["maintenance", "idle"] as const).map((kind) => ({
    label: `broker release ${kind} immediately reacquires in another Worker`,
    async run(name: string) {
      const started = performance.now();
      const names = Array.from({ length: 8 }, (_, chain) => `${name}-${chain}`);
      if (kind === "idle")
        for (const database of names)
          await allocation?.allocate({ kind: "indexeddb", name: database });
      const results = await Promise.allSettled(
        names.map((database) => releaseChain(database, kind, kind === "maintenance" ? 50 : 8)),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      assert(!failures.length, `broker release ${kind}: ${failures.map(String).join("; ")}`);
      console.log(
        `Storage release ${kind}: ${names.length * (kind === "maintenance" ? 50 : 8)} trials in ${performance.now() - started} ms`,
      );
    },
  }));
}
