import { expect, test } from "bun:test";
import { claimOutcome, outcomeWord, readOutcome } from "../proc/outcome.js";

for (const code of [
  0,
  23,
  126,
  127,
  143,
  -1,
  -2147483648,
  2147483647,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
]) {
  test(`terminal exit ${code} round-trips without truncation and wins against later kill`, () => {
    const word = outcomeWord();
    expect(readOutcome(word)).toBeNull();
    expect(claimOutcome(word, { kind: "exited", code })).toEqual({
      kind: "exited",
      code,
      status: code,
    });
    expect(
      claimOutcome(outcomeWord(word.buffer as SharedArrayBuffer), { kind: "signaled", code: 9 }),
    ).toEqual({ kind: "exited", code, status: code });
  });
}

for (const [code, error] of [
  [2, "ENOENT"],
  [13, "EACCES"],
] as const) {
  test(`start failure ${error} has no exit status and wins against exit and kill`, () => {
    const word = outcomeWord();
    const expected = { kind: "start-failed", code, error, status: null } as const;
    expect(claimOutcome(word, { kind: "start-failed", code })).toEqual(expected);
    expect(claimOutcome(word, { kind: "exited", code: 127 })).toEqual(expected);
    expect(claimOutcome(word, { kind: "signaled", code: 9 })).toEqual(expected);
  });
}

test("the same status retains distinct own-exit and default-signal outcome kinds", () => {
  expect(claimOutcome(outcomeWord(), { kind: "exited", code: 143 })).toEqual({
    kind: "exited",
    code: 143,
    status: 143,
  });
  expect(claimOutcome(outcomeWord(), { kind: "signaled", code: 15 })).toEqual({
    kind: "signaled",
    code: 15,
    status: 143,
  });
});

test("a competing terminal claim at the CAS boundary wins immutably", () => {
  const word = outcomeWord();
  const original = Atomics.compareExchange;
  let raced = false;
  Atomics.compareExchange = ((
    array: BigInt64Array,
    index: number,
    expected: bigint,
    replacement: bigint,
  ) => {
    if (!raced && array === word) {
      raced = true;
      claimOutcome(word, { kind: "signaled", code: 9 });
    }
    return original(array, index, expected, replacement);
  }) as typeof Atomics.compareExchange;
  try {
    expect(claimOutcome(word, { kind: "exited", code: 126 })).toEqual({
      kind: "signaled",
      code: 9,
      status: 137,
    });
  } finally {
    Atomics.compareExchange = original;
  }
  expect(raced).toBe(true);
  expect(claimOutcome(word, { kind: "exited", code: 23 })).toEqual({
    kind: "signaled",
    code: 9,
    status: 137,
  });
});

for (const signal of [2, 9, 13, 15]) {
  test(`default signal ${signal} and guest exit share one immutable terminal winner`, () => {
    const killed = outcomeWord();
    expect(claimOutcome(killed, { kind: "signaled", code: signal })).toEqual({
      kind: "signaled",
      code: signal,
      status: 128 + signal,
    });
    expect(claimOutcome(killed, { kind: "exited", code: 0 })).toEqual({
      kind: "signaled",
      code: signal,
      status: 128 + signal,
    });
    const exited = outcomeWord();
    claimOutcome(exited, { kind: "exited", code: 23 });
    expect(claimOutcome(exited, { kind: "signaled", code: signal })).toEqual({
      kind: "exited",
      code: 23,
      status: 23,
    });
  });
}

for (const signal of [2, 13, 15]) {
  test(`default signal ${signal} wins a guest exit CAS race immutably`, () => {
    const word = outcomeWord();
    const original = Atomics.compareExchange;
    let raced = false;
    Atomics.compareExchange = ((
      array: BigInt64Array,
      index: number,
      expected: bigint,
      replacement: bigint,
    ) => {
      if (!raced && array === word) {
        raced = true;
        claimOutcome(word, { kind: "signaled", code: signal });
      }
      return original(array, index, expected, replacement);
    }) as typeof Atomics.compareExchange;
    try {
      expect(claimOutcome(word, { kind: "exited", code: 0 })).toEqual({
        kind: "signaled",
        code: signal,
        status: 128 + signal,
      });
    } finally {
      Atomics.compareExchange = original;
    }
    expect(raced).toBe(true);
    expect(claimOutcome(word, { kind: "exited", code: 23 })).toEqual({
      kind: "signaled",
      code: signal,
      status: 128 + signal,
    });
  });
}

// Entry shares the terminal CAS; observers of ordinary liveness never see a new outcome kind.
for (const terminal of [
  { kind: "exited", code: 127 },
  { kind: "signaled", code: 9 },
] as const) {
  test(`started-running remains live and ${terminal.kind} claims exactly once`, async () => {
    const { markStarted, startStatus } = await import("../proc/outcome.js");
    const word = outcomeWord();
    expect(startStatus(word)).toBe(-6);
    expect(markStarted(word)).toBe(true);
    expect(markStarted(word)).toBe(true);
    expect(readOutcome(word)).toBeNull();
    expect(startStatus(word)).toBe(0);
    const winner = claimOutcome(word, terminal);
    expect(readOutcome(word)).toEqual(winner);
    expect(claimOutcome(word, { kind: "exited", code: 23 })).toEqual(winner);
    expect(startStatus(word)).toBe(0);
    expect(markStarted(word)).toBe(false);
  });
}

for (const first of ["entry", "terminal"] as const)
  test(`${first} wins a terminal-versus-entry CAS race consistently`, async () => {
    const { markStarted, startStatus } = await import("../proc/outcome.js");
    const word = outcomeWord(),
      original = Atomics.compareExchange;
    let raced = false,
      entered: boolean | undefined;
    Atomics.compareExchange = ((
      array: BigInt64Array,
      index: number,
      expected: bigint,
      replacement: bigint,
    ) => {
      if (array === word && !raced) {
        raced = true;
        if (first === "entry") entered = markStarted(word);
        else claimOutcome(word, { kind: "signaled", code: 9 });
      }
      return original(array, index, expected, replacement);
    }) as typeof Atomics.compareExchange;
    try {
      if (first === "entry") claimOutcome(word, { kind: "signaled", code: 9 });
      else entered = markStarted(word);
    } finally {
      Atomics.compareExchange = original;
    }
    expect(raced).toBe(true);
    expect(entered).toBe(first === "entry");
    expect(readOutcome(word)).toEqual({ kind: "signaled", code: 9, status: 137 });
    expect(startStatus(word)).toBe(first === "entry" ? 0 : -11);
  });

test("startup failure prevents entry, while entry forbids a later startup-failure claim", async () => {
  const { markStarted, startStatus } = await import("../proc/outcome.js");
  const failed = outcomeWord();
  claimOutcome(failed, { kind: "start-failed", code: 2 });
  expect(markStarted(failed)).toBe(false);
  expect(startStatus(failed)).toBe(44);
  const started = outcomeWord();
  markStarted(started);
  expect(() => claimOutcome(started, { kind: "start-failed", code: 2 })).toThrow(
    "startup failure after executable entry",
  );
  expect(readOutcome(started)).toBeNull();
  expect(startStatus(started)).toBe(0);
});
