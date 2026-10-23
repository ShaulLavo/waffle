import { expect, test } from "bun:test";
import { MemoryBackend } from "../fs/backend";
import { FilesystemClient } from "../fs/client";
import { FilesystemService } from "../fs/service";
import { createFilesystemConnection } from "../fs/protocol";
import { ResidentGrantCell, type ResidentDescriptor } from "../fs/publication-grant";
import { SharedFilesystem } from "../browser/shared-fs";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const reopen of [false, true]) {
  test(`a cut rejects an unadmitted producer without allocating input, reopen=${reopen}`, async () => {
    const pair = createFilesystemConnection();
    const client = new FilesystemClient(pair.client);
    const gate = client.shared.writeAdmission;
    const held = Array.from({ length: 63 }, () => gate.admit(pair.client.owner));
    let copies = 0;
    const preparing = client
      .prepareAsync(
        "writeFile",
        ["/late"],
        () => {
          copies++;
          return new Uint8Array(8);
        },
        8,
      )
      .then(
        () => "prepared",
        (error: unknown) => error,
      );
    try {
      await turn();
      expect(copies).toBe(0);
      expect(gate.active).toBe(63);
      const lease = gate.close();
      if (reopen) gate.open(lease);
      for (const ticket of held) gate.finish(ticket);
      expect(await preparing).toMatchObject({ errno: 6 });
      expect(copies).toBe(0);
      expect(gate.active).toBe(0);
      gate.open(lease);
    } finally {
      for (const ticket of held) gate.finish(ticket);
      client.dispose();
      pair.server.port.close();
    }
  });
}

for (const failure of [undefined, null, false, 0, ""]) {
  test(`page execution preserves a falsy rejection ${String(failure)}`, async () => {
    const pair = createFilesystemConnection();
    const client = new FilesystemClient(pair.client);
    const completion = client.prepare("writeFile", ["/queued"], new Uint8Array(1));
    let dispatches = 0;
    client.prepareAsync = async () => completion;
    client.dispatch = () => {
      dispatches++;
    };
    completion.value = () => Promise.reject(failure);
    const page: SharedFilesystem = Object.assign(Object.create(SharedFilesystem.prototype), {
      client,
      worker: { terminate() {}, postMessage() {} },
      writes: Promise.resolve(),
      barrierRequests: new Map(),
      _state: { status: "ready" },
    });
    try {
      const outcome = await page.writeFile("/queued", "x").then(
        () => ({ kind: "success" }),
        (error: unknown) => ({ kind: "failure", error }),
      );
      expect(outcome).toEqual({ kind: "failure", error: failure });
      expect(dispatches).toBe(1);
      const drained = await page.drain().then(
        () => ({ kind: "success" }),
        (error: unknown) => ({ kind: "failure", error }),
      );
      expect(drained).toEqual({ kind: "failure", error: failure });
      expect(client.shared.writeAdmission.active).toBe(0);
    } finally {
      completion.release();
      client.dispose();
      pair.server.port.close();
    }
  });
}

for (const outcome of ["stopped", "wrong-kind", "mismatched-import", "failed-apply"] as const) {
  test(`resident ${outcome} retires the exact execution before acquisition fails`, async () => {
    const original = new Error("resident apply failure");
    class Backend extends MemoryBackend {
      fail = false;
      override applyPublication(plan: Parameters<MemoryBackend["applyPublication"]>[0]): void {
        if (this.fail) throw original;
        super.applyPublication(plan);
      }
    }
    const backend = new Backend();
    const service = new FilesystemService(backend);
    const pair = createFilesystemConnection(undefined, {
      observe: true,
      limits: {
        sessions: 8,
        operations: 16,
        inputBytes: 64,
        argumentBytes: 1024,
        effectBytes: 4096,
        effects: 16,
        resultBytes: 256,
        logRecords: 4,
        logBytes: 16384,
        pins: 2,
        pinBytes: 256,
      },
    });
    service.connect(pair.server);
    const client = new FilesystemClient(pair.client);
    let pause: Promise<unknown> | undefined;
    try {
      await client.asyncCall("writeFile", ["/shared"], new Uint8Array(1));
      const root: number = await client.asyncCall("preopen", ["/"]);
      const path: { node: number } = await client.asyncCall("resolve", [root, "shared"]);
      const descriptor: ResidentDescriptor = await client.asyncCall("publicationResident", [
        pair.client.publication!.observer,
        path.node,
        "terminal-ticket",
      ]);
      const authority = service.residentPublication!;
      authority.activate();
      const session = authority.open(descriptor);
      const grant = authority.prepare(session, { kind: "write", offset: 0, maxBytes: 1 });
      pause = service.pauseFilesystemWrites().then(
        () => "acquired",
        (error: unknown) => error,
      );
      const cell = new ResidentGrantCell(grant);
      expect(cell.tryWrite(path.node, [new Uint8Array([2])], 0)).toBe(1);
      const committed = cell.snapshot();
      if (committed.kind !== "committed") throw new Error("missing committed grant");
      backend.fail = outcome === "failed-apply";
      let failure: unknown;
      try {
        if (outcome === "stopped") authority.settle(session, { kind: "stopped", grant: grant.key });
        if (outcome === "wrong-kind")
          authority.settle(session, { kind: "read", grant: grant.key, count: 0, cut: grant.cut });
        if (outcome === "mismatched-import")
          authority.settle(session, {
            ...committed,
            publication: { ...committed.publication, changes: [] },
          });
        if (outcome === "failed-apply") authority.settle(session, committed);
      } catch (error) {
        failure = error;
      }
      if (outcome === "failed-apply") expect(failure).toBe(original);
      else expect(failure).toMatchObject({ errno: 29 });
      expect(backend.shared.writeAdmission.active).toBe(0);
      expect(await pause).toMatchObject({ errno: 6 });
    } finally {
      client.dispose();
      service.dispose();
      pair.server.port.close();
      await pause;
    }
  });
}
