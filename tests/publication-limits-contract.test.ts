import { expect, test } from "bun:test";
import { createPersistentResidentOwner } from "../browser/persistent-resident-owner";
import { createPublicationBuffers, validatePublicationLimits } from "../fs/publication";
import type { PublicationLimits } from "../fs/publication-internal";
import { INDEXEDDB_FORMAT } from "../fs/vfs-format";

import { residentMemory } from "./fixtures/resident-memory";

const limits: PublicationLimits = {
  sessions: 4,
  operations: 4,
  inputBytes: 64,
  argumentBytes: 512,
  effectBytes: 4096,
  effects: 16,
  resultBytes: 256,
  logRecords: 2,
  logBytes: 8192,
  pins: 1,
  pinBytes: 64,
};

test("publication limits return a frozen owned value with optional session quotas", () => {
  const input = { ...limits };
  const validated = validatePublicationLimits(input);
  expect(validated).toEqual(limits);
  expect(validated).not.toBe(input);
  expect(Object.isFrozen(validated)).toBe(true);
  input.operations = 8;
  expect(validated.operations).toBe(4);
  expect(validated.operationsPerSession).toBeUndefined();
  expect(validatePublicationLimits({ ...limits, operationsPerSession: 1 })).toEqual({
    ...limits,
    operationsPerSession: 1,
  });
});

test("publication limits reject invalid integers and combined arena bounds without allocation", () => {
  const fields = Object.keys({ ...limits, operationsPerSession: 1 });
  for (const field of fields) {
    for (const value of [0, -1, 1.5, NaN, Infinity, 0x7fffffff])
      expect(() => validatePublicationLimits({ ...limits, [field]: value })).toThrow(RangeError);
  }
  for (const invalid of [
    { ...limits, operationsPerSession: 2 },
    { ...limits, logBytes: 8191 },
    { ...limits, operations: 0x7ffffffe },
    { ...limits, inputBytes: 0x7ffffffe },
  ]) {
    expect(() => validatePublicationLimits(invalid)).toThrow(RangeError);
    expect(() => createPublicationBuffers(invalid)).toThrow(RangeError);
  }
});

test("invalid resident arenas fail synchronously before any native ownership or storage access", () => {
  const originals = new Map(
    ["location", "navigator", "indexedDB"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const nativeAccesses: string[] = [];
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "https://publication-admission.test" },
  });
  for (const key of ["navigator", "indexedDB"])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      get() {
        nativeAccesses.push(key);
        throw new Error(`invalid arena reached ${key}`);
      },
    });
  try {
    for (const invalid of [
      { ...limits, sessions: 0 },
      { ...limits, logBytes: 8191 },
    ])
      expect(() =>
        createPersistentResidentOwner(
          {
            kind: "initial-open",
            runtimeLifetime: "limits-contract",
            attempt: "invalid-arena",
            selected: {
              origin: "https://publication-admission.test",
              name: "invalid-arena",
              implementation: "indexeddb",
              format: INDEXEDDB_FORMAT,
            },
            publication: { limits: invalid },
          },
          new AbortController().signal,
          undefined,
          residentMemory(),
        ),
      ).toThrow(RangeError);
    expect(nativeAccesses).toEqual([]);
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
