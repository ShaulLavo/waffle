import { expect, test } from "bun:test";
import { PAGE } from "../fs/protocol";
import type { ReadOutcome, ReadValue, WorkspaceVfs } from "../fs/workspace-types";
import { residentReadFixture } from "./fixtures/workspace-read";
import {
  assertWorkspaceQuiescent,
  workspaceEnduranceFixture,
  workspaceOwnership,
  type WorkspaceEnduranceValue,
} from "./fixtures/workspace-endurance";

const CYCLES = 16;
type Fixture = Awaited<ReturnType<typeof workspaceEnduranceFixture>>;

function assertRange(value: Fixture, result: ReadOutcome<ReadValue>, offset: number): void {
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw new Error(`range failed: ${result.kind}`);
  expect(result.value.range).toEqual({ offset, length: PAGE + 17 });
  expect(result.value.bytes).toEqual(value.bytes.slice(offset, offset + PAGE + 17));
}

async function readCycle(value: Fixture, cycle: number): Promise<void> {
  const offset = cycle % PAGE;
  const result = await value.workspace.read("/file", { offset, length: PAGE + 17 });
  assertRange(value, result, offset);
  assertWorkspaceQuiescent(value, value.baseline);
}

async function leaseCycle(value: Fixture, cycle: number): Promise<void> {
  const opened = await value.workspace.pin("/file");
  expect(opened.kind).toBe("ok");
  if (opened.kind !== "ok") throw new Error(`lease failed: ${opened.kind}`);
  try {
    const offset = cycle % PAGE;
    assertRange(value, await opened.value.read({ offset, length: PAGE + 17 }), offset);
  } finally {
    await opened.value.close();
  }
  assertWorkspaceQuiescent(value, value.baseline);
}

function holdChunk(value: Fixture) {
  const submit = value.client.submit;
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let held = false;
  value.client.submit = function (...args) {
    const completion = submit.apply(this, args);
    if (held || args[0] !== "publicationReadChunk") return completion;
    held = true;
    const deliver = completion.value.bind(completion);
    completion.value = async () => {
      const bytes: unknown = await deliver().catch((error: unknown) => {
        entered.reject(error);
        throw error;
      });
      entered.resolve();
      await gate.promise;
      return bytes;
    };
    return completion;
  };
  return {
    entered,
    gate,
    restore: () => {
      value.client.submit = submit;
    },
  };
}

async function requireHeld(entered: Promise<void>, reading: Promise<ReadOutcome<ReadValue>>) {
  const state = await Promise.race([
    entered.then(() => ({ kind: "held" as const })),
    reading.then((result) => ({ kind: "settled" as const, result })),
  ]);
  if (state.kind !== "held")
    throw new Error(`range settled before held chunk: ${state.result.kind}`);
}

async function cancellationCycle(value: Fixture, cycle: number): Promise<void> {
  const held = holdChunk(value);
  const controller = new AbortController();
  const reading = value.workspace.read(
    "/file",
    { offset: cycle % PAGE, length: PAGE + 17 },
    undefined,
    controller.signal,
  );
  try {
    await requireHeld(held.entered.promise, reading);
    const active = workspaceOwnership(value);
    expect(active.readerOperations).toBe(0);
    expect(active.readerTickets).toBe(1);
    expect(active.readerLeases).toBe(0);
    expect(active.readerPinBytes).toBe(PAGE * 2);
    expect(active.readerResultBytes).toBeGreaterThan(0);
    controller.abort();
    held.gate.resolve();
    expect(await reading).toEqual({ kind: "cancelled" });
    assertWorkspaceQuiescent(value, value.baseline);
  } finally {
    controller.abort();
    held.gate.resolve();
    try {
      await reading;
    } finally {
      held.restore();
    }
  }
}

async function cycles(run: (value: Fixture, cycle: number) => Promise<void>): Promise<void> {
  const value = await workspaceEnduranceFixture();
  try {
    for (let cycle = 0; cycle < CYCLES; cycle++) await run(value, cycle);
  } finally {
    await value.close();
  }
}

test(`bounded public range reads release ownership after ${CYCLES} cycles`, () =>
  cycles(readCycle));
test(`bounded public leases release retained ownership after ${CYCLES} cycles`, () =>
  cycles(leaseCycle));
test(`bounded public cancellation releases ownership after ${CYCLES} cycles`, () =>
  cycles(cancellationCycle));

const serviceCounters = [
  "clients",
  "readerLeases",
  "readerMetadataBytes",
  "readerOperations",
  "readerPinBytes",
  "readerResultBytes",
  "readerSeedBytes",
  "readerTickets",
  "responses",
  "retained",
  "transient",
  "workspaceCursors",
];

function assertInvalidCounter(value: Fixture, name: string, invalid: unknown): void {
  const resources = value.service.resources;
  const descriptor = Object.getOwnPropertyDescriptor(value.service, "resources");
  Object.defineProperty(value.service, "resources", {
    configurable: true,
    value: () => ({ ...resources.call(value.service), [name]: invalid }),
  });
  try {
    expect(() => workspaceOwnership(value)).toThrow(`counter missing or invalid: ${name}`);
  } finally {
    if (descriptor) Object.defineProperty(value.service, "resources", descriptor);
    else Reflect.deleteProperty(value.service, "resources");
  }
}

test("endurance requires every service ownership counter to exist and be finite", async () => {
  const value = await workspaceEnduranceFixture();
  try {
    for (const name of serviceCounters) {
      assertInvalidCounter(value, name, undefined);
      assertInvalidCounter(value, name, Number.NaN);
      assertInvalidCounter(value, name, Infinity);
    }
  } finally {
    await value.close();
  }
});

function failChunks(value: Fixture) {
  const submit = value.client.submit;
  value.client.submit = function (...args) {
    const completion = submit.apply(this, args);
    if (args[0] !== "publicationReadChunk") return completion;
    const deliver = completion.value.bind(completion);
    completion.value = async () => {
      await deliver();
      throw new Error("chunk failed before hold");
    };
    return completion;
  };
  return () => {
    value.client.submit = submit;
  };
}

test("an early chunk failure joins cleanup instead of waiting for an unreachable hold", async () => {
  const value = await workspaceEnduranceFixture();
  const restore = failChunks(value);
  const failing = value.client.submit;
  try {
    const failure: unknown = await cancellationCycle(value, 0).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : null).toBe("chunk failed before hold");
    expect(value.client.submit).toBe(failing);
    assertWorkspaceQuiescent(value, value.baseline);
  } finally {
    restore();
    await value.close();
  }
});

function failingSetup(
  record: { closes: number },
  cause: unknown,
  cleanup?: { cause: unknown },
): typeof residentReadFixture {
  return async (...args) => {
    const value = await residentReadFixture(...args);
    const workspace: WorkspaceVfs = { ...value.workspace, read: () => Promise.reject(cause) };
    const close = async () => {
      record.closes++;
      await value.close();
      if (cleanup) throw cleanup.cause;
    };
    return { ...value, workspace, close } satisfies WorkspaceEnduranceValue;
  };
}

test("failed endurance warmup closes the acquired real fixture", async () => {
  const record = { closes: 0 };
  const cause = new Error("warmup failed");
  await expect(workspaceEnduranceFixture(undefined, failingSetup(record, cause))).rejects.toBe(
    cause,
  );
  expect(record.closes).toBe(1);
});

test("failed endurance warmup preserves the primary and falsy cleanup failure", async () => {
  const record = { closes: 0 };
  const result = workspaceEnduranceFixture(
    undefined,
    failingSetup(record, undefined, { cause: false }),
  );
  await expect(result).rejects.toBeInstanceOf(AggregateError);
  const error: unknown = await result.catch((reason: unknown) => reason);
  expect(error instanceof AggregateError ? error.errors : null).toEqual([undefined, false]);
  expect(record.closes).toBe(1);
});
