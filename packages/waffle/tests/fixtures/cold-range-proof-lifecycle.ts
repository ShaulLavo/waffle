import {
  createFilesystemConnection,
  createWorkspaceVfs,
  FilesystemClient,
  FilesystemService,
  PersistentBackend,
} from "../../fs";
import type { OpfsStorage } from "../../fs/opfs";
import { RangeFixture } from "./opfs-range-storage";

type Settlement<T> = { kind: "fulfilled"; value: T } | { kind: "rejected"; reason: unknown };
type ReleaseName =
  | "gate"
  | "read"
  | "workspace"
  | "client"
  | "service-drain"
  | "service-dispose"
  | "backend"
  | "client-port"
  | "server-port"
  | "physical";
const releaseOrder: readonly ReleaseName[] = [
  "gate",
  "read",
  "workspace",
  "client",
  "service-drain",
  "service-dispose",
  "backend",
  "client-port",
  "server-port",
  "physical",
];

async function settle<T>(operation: () => T | Promise<T>): Promise<Settlement<T>> {
  try {
    return { kind: "fulfilled", value: await operation() };
  } catch (reason) {
    return { kind: "rejected", reason };
  }
}

function activeAccesses(directory: RangeFixture["root"]): number {
  let active = 0;
  for (const node of directory.nodes.values()) {
    if (node.kind === "directory") active += activeAccesses(node);
    else active += node.accesses.filter((access) => access.active).length;
  }
  return active;
}

export class ColdRangeProof {
  readonly physical = new RangeFixture();
  readonly gate = this.physical.gate();
  readonly entered = Promise.withResolvers<void>();
  snapshotEntries = 0;
  readonly releases: { name: ReleaseName; outcome: Settlement<void> }[] = [];
  private readonly owned = new Map<ReleaseName, () => void | Promise<void>>();
  private terminal?: Promise<Settlement<unknown>>;
  beforePhysical?: {
    lockHeld: boolean;
    activeAccesses: number;
    storageHandles: (number | undefined)[];
  };

  constructor() {
    this.owned.set("gate", () => this.gate.resolve());
    this.owned.set("physical", () => {
      this.beforePhysical = {
        lockHeld: this.physical.held,
        activeAccesses: activeAccesses(this.physical.root),
        storageHandles: this.physical.owners.map((owner) => owner.resources().opfsHandles),
      };
      return this.physical.cleanup();
    });
  }

  async connect(storage: OpfsStorage) {
    const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
    this.owned.set("backend", () => backend.close());
    const pair = createFilesystemConnection(undefined, { workspace: true });
    this.owned.set("client-port", () => pair.client.port.close());
    this.owned.set("server-port", () => pair.server.port.close());
    const service = new FilesystemService(backend);
    this.owned.set("service-drain", () => service.drainForOwner());
    this.owned.set("service-dispose", () => service.dispose());
    service.connect(pair.server);
    const client = new FilesystemClient(pair.client);
    this.owned.set("client", () => client.dispose());
    const workspace = createWorkspaceVfs(client);
    this.owned.set("workspace", () => workspace.close());
    return { backend, client, service, workspace };
  }

  track<T>(operation: () => Promise<T>): Promise<T> {
    this.physical.file().snapshotRead = async () => {
      this.snapshotEntries++;
      this.entered.resolve();
      await this.gate.promise;
    };
    const reading = operation();
    this.terminal = settle(() => reading);
    this.owned.set("read", async () => {
      await reading;
    });
    return reading;
  }

  async waitForEntry(): Promise<void> {
    if (!this.terminal) throw new Error("No tracked read");
    const terminal = this.terminal.then((outcome) => {
      if (outcome.kind === "rejected") throw outcome.reason;
      throw outcome.value;
    });
    await Promise.race([this.entered.promise, terminal]);
  }

  async close(): Promise<void> {
    for (const name of releaseOrder) {
      const release = this.owned.get(name);
      if (!release) continue;
      this.owned.delete(name);
      this.releases.push({ name, outcome: await settle(release) });
    }
  }

  async run<T>(body: () => Promise<T>): Promise<T> {
    const primary = await settle(body);
    await this.close();
    if (primary.kind === "rejected") throw primary.reason;
    const failure = this.releases.find(({ outcome }) => outcome.kind === "rejected");
    if (failure?.outcome.kind === "rejected") throw failure.outcome.reason;
    return primary.value;
  }
}
