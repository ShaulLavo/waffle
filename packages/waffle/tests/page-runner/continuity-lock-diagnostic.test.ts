import { expect, test } from "bun:test";
import {
  observeContinuityLocks,
  projectContinuityDiagnostic,
} from "./continuity-lock-diagnostic.js";
import { StallDiagnostics } from "./stall-diagnostics.js";

class Manager implements Pick<LockManager, "request" | "query"> {
  requests = 0;
  queries = 0;
  available = false;
  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(
    name: string,
    options: LockOptions | LockGrantedCallback<T>,
    supplied?: LockGrantedCallback<T>,
  ): Promise<T> {
    this.requests++;
    const callback = typeof options === "function" ? options : supplied;
    if (!callback) throw new Error("Missing callback");
    const lock: Lock = { name, mode: "exclusive" };
    return Promise.resolve(callback(this.available ? lock : null));
  }
  query(): Promise<LockManagerSnapshot> {
    this.queries++;
    return Promise.resolve({ held: [], pending: [] });
  }
}
const key = "waffle:publication:continuity:private-token";
const owner = () => ({ activeJobs: [7], activeJobCount: 1 });

async function initialRefusal() {
  const manager = new Manager();
  const observer = observeContinuityLocks(manager, owner);
  await manager.request(key, {}, () => false);
  return { manager, observer };
}

function expectInitialEvidence(value: ReturnType<typeof projectContinuityDiagnostic>) {
  expect(value.records[0]).toMatchObject({ requests: [1], phase: "request-invoked" });
  expect(value.records[1]).toMatchObject({ requests: [1], phase: "callback-null" });
}

test("later request/query traffic preserves the first admission and refusal", async () => {
  const { manager, observer } = await initialRefusal();
  manager.available = true;
  for (let index = 0; index < 16; index++) {
    await manager.request(key, {}, () => true);
    await manager.query();
  }
  const snapshot = observer.snapshot();
  expectInitialEvidence(snapshot);
  expectInitialEvidence(projectContinuityDiagnostic(snapshot));
  expect(snapshot.records.length).toBeLessThanOrEqual(32);
  expect(snapshot.dropped).toBeGreaterThan(0);
  expect(new TextEncoder().encode(JSON.stringify(snapshot)).length).toBeLessThanOrEqual(8192);
  expect(manager.requests).toBe(17);
  expect(manager.queries).toBe(16);
});

test("projection and aggregate byte trimming retain initial evidence on every page", async () => {
  const { observer } = await initialRefusal();
  const initial = observer.snapshot();
  const later = Array.from({ length: 80 }, (_, index) => ({
    ordinal: index + 4,
    requests: Array.from({ length: 32 }, (_, id) => Number.MAX_SAFE_INTEGER - id),
    correlation: {
      jobs: Array.from({ length: 8 }, (_, id) => Number.MAX_SAFE_INTEGER - id),
      count: 8,
      ambiguous: true,
    },
    phase: "request-invoked",
  }));
  const records: readonly unknown[] = initial.records;
  const projected = projectContinuityDiagnostic({
    ...initial,
    records: records.concat(later),
  });
  expectInitialEvidence(projected);
  expect(projected.dropped).toBeGreaterThan(80 - 32);
  expect(new TextEncoder().encode(JSON.stringify(projected)).length).toBeLessThanOrEqual(8192);
  const host = new StallDiagnostics();
  for (let peer = 1; peer <= 16; peer++) {
    host.page(peer, {
      clock: "page-monotonic-ms",
      entries: [],
      unavailable: 0,
      continuityLocks: projected,
    });
  }
  const evidence = host.current().evaluations;
  expect(JSON.stringify(evidence).length).toBeLessThanOrEqual(65536);
  expect(evidence.truncated).toBeGreaterThan(0);
  expect(evidence.pages.length).toBe(16);
  for (const page of evidence.pages) expectInitialEvidence(page.evidence.continuityLocks);
});

test("same-job unrelated queries remain ambiguous candidates without consuming the request", async () => {
  const manager = new Manager();
  manager.available = true;
  const observer = observeContinuityLocks(manager, owner);
  await manager.request(key, {}, () => true);
  await manager.query();
  await manager.query();
  const queries = observer.snapshot().records.filter((entry) => entry.phase === "query-fulfilled");
  expect(queries.length).toBe(2);
  for (const query of queries) {
    expect(query.requests).toEqual([1]);
    expect(query.correlation.ambiguous).toBe(true);
  }
  const projected = projectContinuityDiagnostic({
    ...observer.snapshot(),
    records: queries.map((query) => ({
      ...query,
      correlation: { ...query.correlation, ambiguous: false },
    })),
  });
  expect(projected.records.every((entry) => entry.correlation.ambiguous)).toBe(true);
  expect(manager.requests).toBe(1);
  expect(manager.queries).toBe(2);
});
