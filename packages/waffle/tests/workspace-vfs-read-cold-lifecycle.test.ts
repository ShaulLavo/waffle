import { expect, test } from "bun:test";
import { ColdRangeProof } from "./fixtures/cold-range-proof-lifecycle";

type View = Awaited<ReturnType<ColdRangeProof["connect"]>>;
type Prepared = Awaited<ReturnType<typeof prepared>>;

function rejectReadClose(view: View, reason: unknown, beforeEntry = false) {
  const submit = view.client.submit;
  view.client.submit = function (...args) {
    if (beforeEntry && args[0] === "publicationReadLeaseOpen") throw new Error("open refused");
    if (args[0] === "publicationReadClose") throw reason;
    return submit.apply(this, args);
  };
}

async function prepared(proof: ColdRangeProof) {
  await proof.physical.seed([65536]);
  const storage = await proof.physical.open();
  const view = await proof.connect(storage);
  const pinned = await view.workspace.pin("/file");
  if (pinned.kind !== "ok") throw new Error(pinned.kind);
  return { view, lease: pinned.value, storage };
}

function assertReleased(proof: ColdRangeProof, resources: Prepared | undefined) {
  expect(proof.releases.map(({ name }) => name)).toEqual([
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
  ]);
  expect(proof.beforePhysical).toEqual({ lockHeld: false, activeAccesses: 0, storageHandles: [0] });
  expect(proof.physical.held).toBe(false);
  if (!resources) throw new Error("setup did not finish");
  expect(resources.storage.resources()).toMatchObject({
    readerStorageBytes: 0,
    opfsReaderWork: 0,
    opfsHandles: 0,
    opfsCachedHandles: 0,
  });
  expect(resources.view.service.resources()).toMatchObject({
    clients: 0,
    readerOperations: 0,
    readerTickets: 0,
    readerResultBytes: 0,
    readerLeases: 0,
    readerPinBytes: 0,
  });
  expect(resources.view.client.completions.size).toBe(0);
  const later = proof.releases.filter(({ name }) => name !== "read" && name !== "workspace");
  expect(later.every(({ outcome }) => outcome.kind === "fulfilled")).toBe(true);
}

async function rejected(
  operation: Promise<unknown>,
): Promise<{ kind: "unexpected-success" } | { kind: "rejected"; reason: unknown }> {
  try {
    await operation;
    return { kind: "unexpected-success" };
  } catch (reason) {
    return { kind: "rejected", reason };
  }
}

function assertFailure(result: Awaited<ReturnType<typeof rejected>>, expected: unknown) {
  expect(result.kind).toBe("rejected");
  if (result.kind !== "rejected") throw new Error("operation unexpectedly fulfilled");
  expect(result.reason).toBe(expected);
}

function assertCloseRejected(proof: ColdRangeProof, reason: unknown) {
  const read = proof.releases.find(({ name }) => name === "read");
  expect(read?.outcome.kind).toBe("rejected");
  if (read?.outcome.kind !== "rejected") throw new Error("read unexpectedly fulfilled");
  expect(read.outcome.reason).toBe(reason);
  const workspace = proof.releases.find(({ name }) => name === "workspace");
  expect(workspace?.outcome.kind).toBe("rejected");
  if (workspace?.outcome.kind !== "rejected") throw new Error("workspace unexpectedly fulfilled");
  const failure = workspace.outcome.reason;
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw new Error("workspace lost its close failures");
  expect(failure.errors).toHaveLength(2);
  expect(failure.errors[0]).toBe(reason);
  expect(failure.errors[1]).toBe(reason);
}

function withProof(body: (proof: ColdRangeProof) => Promise<void>): () => Promise<void> {
  return async () => {
    const proof = new ColdRangeProof();
    try {
      await body(proof);
    } finally {
      await proof.close();
    }
  };
}

test(
  "post-entry rejected copyRead still attempts every owned release",
  withProof(async (proof) => {
    const failure = { source: "publicationReadClose" };
    let resources: Prepared | undefined;
    const result = await rejected(
      proof.run(async () => {
        resources = await prepared(proof);
        const { view, lease } = resources;
        rejectReadClose(view, failure);
        const reading = proof.track(() => lease.read({ offset: 0, length: 1 }));
        await proof.waitForEntry();
        proof.gate.resolve();
        await reading;
      }),
    );
    assertFailure(result, failure);
    expect(proof.snapshotEntries).toBe(1);
    assertReleased(proof, resources);
    assertCloseRejected(proof, failure);
  }),
);

for (const kind of ["refusal", "rejection", "completion"]) {
  test(
    `pre-entry ${kind} reaches owned cleanup without a payload callback`,
    withProof(async (proof) => {
      const failure = { source: "pre-entry close" };
      let resources: Prepared | undefined;
      let terminal: unknown;
      const result = await rejected(
        proof.run(async () => {
          resources = await prepared(proof);
          const { view, lease } = resources;
          if (kind === "refusal") await lease.close();
          if (kind === "rejection") rejectReadClose(view, failure, true);
          const reading = proof.track(() =>
            lease.read({ offset: 0, length: kind === "completion" ? 0 : 1 }),
          );
          void reading.then(
            (value) => {
              terminal = value;
            },
            (reason) => {
              terminal = reason;
            },
          );
          await proof.waitForEntry();
        }),
      );
      if (kind === "refusal") expect(terminal).toEqual({ kind: "lease-closed" });
      if (kind === "rejection") expect(terminal).toBe(failure);
      if (kind === "completion") expect(terminal).toMatchObject({ kind: "ok" });
      assertFailure(result, kind === "rejection" ? failure : terminal);
      expect(proof.snapshotEntries).toBe(0);
      expect(proof.physical.file().reads).toHaveLength(0);
      assertReleased(proof, resources);
      if (kind === "rejection") assertCloseRejected(proof, failure);
    }),
  );
}

const earlier = { source: "earlier body failure" };
for (const primary of [earlier, undefined, null, false, 0, ""]) {
  test(
    `earlier ${String(primary)} survives rejected read and workspace cleanup`,
    withProof(async (proof) => {
      const cleanupFailure = { source: "cleanup close" };
      let resources: Prepared | undefined;
      const result = await rejected(
        proof.run(async () => {
          resources = await prepared(proof);
          const { view, lease } = resources;
          rejectReadClose(view, cleanupFailure);
          proof.track(() => lease.read({ offset: 0, length: 1 }));
          await proof.waitForEntry();
          throw primary;
        }),
      );
      assertFailure(result, primary);
      assertCloseRejected(proof, cleanupFailure);
      assertReleased(proof, resources);
    }),
  );
}

for (const cleanupFailure of [undefined, null, false, 0, ""]) {
  test(
    `successful body reports ${String(cleanupFailure)} cleanup failure`,
    withProof(async (proof) => {
      let resources: Prepared | undefined;
      const result = await rejected(
        proof.run(async () => {
          resources = await prepared(proof);
          const { view, lease } = resources;
          rejectReadClose(view, cleanupFailure);
          proof.track(() => lease.read({ offset: 0, length: 1 }));
          await proof.waitForEntry();
        }),
      );
      assertFailure(result, cleanupFailure);
      assertCloseRejected(proof, cleanupFailure);
      assertReleased(proof, resources);
    }),
  );
}

for (const kind of ["refusal", "rejection"]) {
  test(
    `pre-entry ${kind} wait is settled by the owned-release checkpoint`,
    withProof(async (proof) => {
      const failure = { source: "checkpoint close" };
      const resources = await prepared(proof);
      const { view, lease } = resources;
      if (kind === "refusal") await lease.close();
      if (kind === "rejection") rejectReadClose(view, failure, true);
      const reading = proof.track(() => lease.read({ offset: 0, length: 1 }));
      const entering = rejected(proof.waitForEntry());
      const terminal = await reading.then(
        (value) => value,
        (reason: unknown) => reason,
      );
      await proof.close();
      const checkpoint = await Promise.race([entering, Promise.resolve({ kind: "stranded" })]);
      expect(checkpoint.kind).toBe("rejected");
      if (checkpoint.kind !== "rejected" || !("reason" in checkpoint))
        throw new Error("terminal read stranded entry wait after all releases settled");
      expect(checkpoint.reason).toBe(terminal);
      expect(proof.snapshotEntries).toBe(0);
      assertReleased(proof, resources);
    }),
  );
}
