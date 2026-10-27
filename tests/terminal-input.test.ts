import { expect, test } from "bun:test";
import { createWorkerProcessTransport } from "../proc/worker-client";
import {
  attachTerminal,
  attachTerminalInput,
  claimTerminalAuthority,
  createTerminalInput,
  createTerminalInputPolicy,
  createTerminalSession,
  pushTerminalInput,
} from "../browser/runtime-terminals";

function must<T>(result: { kind: "ok"; value: T } | { kind: "error"; code: string }): T {
  if (result.kind === "error") throw new Error(result.code);
  return result.value;
}

function read(
  display: ReturnType<typeof createTerminalSession>,
  policy: ReturnType<typeof createTerminalInputPolicy>,
  chunks: readonly Uint8Array[],
  mode?: "raw" | "cooked",
): number {
  let result = 0;
  const accepted = display.input((value) => {
    result = policy.tryRead(mode ? { ...value, mode } : value, chunks);
    return 0;
  });
  expect(accepted.kind).toBe("ok");
  return result;
}

test("generic terminal input keeps live empty reads pending and delivers raw bytes once", () => {
  const input = createTerminalInput({ capacity: 8 });
  const display = createTerminalSession({
    controller: createWorkerProcessTransport({ capacity: 4 }),
    geometry: { columns: 80, rows: 24 },
  });
  const policy = createTerminalInputPolicy({ input });
  try {
    const destination = new Uint8Array(3);
    expect(read(display, policy, [destination])).toBe(-6);
    expect(input.push(new Uint8Array([65, 66, 67]))).toBe(3);
    expect(read(display, policy, [destination], "raw")).toBe(3);
    expect(Array.from(destination)).toEqual([65, 66, 67]);
    expect(input.push(new Uint8Array([13, 10]))).toBe(2);
    const lineEnd = new Uint8Array(2);
    expect(read(display, policy, [lineEnd], "raw")).toBe(2);
    expect(Array.from(lineEnd)).toEqual([13, 10]);
    expect(read(display, policy, [new Uint8Array(1)], "raw")).toBe(-6);
  } finally {
    display.close("disposed");
  }
});

test("generic terminal input normalizes cooked CRLF without dropping a split line ending", () => {
  const input = createTerminalInput({ capacity: 8 });
  const display = createTerminalSession({
    controller: createWorkerProcessTransport({ capacity: 4 }),
    geometry: { columns: 80, rows: 24 },
  });
  const policy = createTerminalInputPolicy({ input });
  try {
    expect(input.push(new Uint8Array([65]))).toBe(1);
    const first = new Uint8Array(2);
    expect(read(display, policy, [first])).toBe(-6);
    expect(input.push(new Uint8Array([13]))).toBe(1);
    expect(read(display, policy, [first])).toBe(2);
    expect(Array.from(first)).toEqual([65, 10]);
    expect(input.push(new Uint8Array([10, 66]))).toBe(2);
    const second = new Uint8Array(1);
    expect(read(display, policy, [second])).toBe(-6);
    input.close();
    expect(read(display, policy, [second])).toBe(1);
    expect(second[0]).toBe(66);
  } finally {
    display.close("disposed");
  }
});

test("generic terminal input exposes Ctrl-D and closure as EOF while raw mode preserves bytes", () => {
  const input = createTerminalInput({ capacity: 8 });
  const attached = attachTerminalInput(input.buffer);
  const display = createTerminalSession({
    controller: createWorkerProcessTransport({ capacity: 4 }),
    geometry: { columns: 80, rows: 24 },
  });
  const policy = createTerminalInputPolicy({ input: attached });
  try {
    expect(input.push(new Uint8Array([4]))).toBe(1);
    expect(read(display, policy, [new Uint8Array(1)])).toBe(0);
    expect(input.push(new Uint8Array([65, 4]))).toBe(2);
    const prefix = new Uint8Array(2);
    expect(read(display, policy, [prefix])).toBe(1);
    expect(prefix[0]).toBe(65);
    expect(read(display, policy, [new Uint8Array(1)])).toBe(-6);
    expect(input.push(new Uint8Array([4]))).toBe(1);
    expect(read(display, policy, [new Uint8Array(1)], "raw")).toBe(1);
    input.close();
    expect(read(display, policy, [new Uint8Array(1)])).toBe(0);
  } finally {
    display.close("disposed");
  }
});

test("generic terminal input producer reports bounded capacity and wakes readers", () => {
  const input = createTerminalInput({ capacity: 2 });
  const before = Atomics.load(input.notification, 0);
  expect(input.push(new Uint8Array([1, 2]))).toBe(2);
  expect(input.push(new Uint8Array([3]))).toBe(-6);
  expect(input.push(new Uint8Array([3, 4, 5]))).toBe(-6);
  expect(input.available()).toBe(2);
  expect(Atomics.load(input.notification, 0)).toBeGreaterThan(before);
  input.close();
  expect(input.push(new Uint8Array([3]))).toBe(-8);
  const canceled = createTerminalInput({ capacity: 2 });
  canceled.cancel();
  expect(canceled.push(new Uint8Array([3]))).toBe(-11);
});

test("cancellation is readable and returns CANCELED instead of pending AGAIN", () => {
  const input = createTerminalInput({ capacity: 8 });
  const display = createTerminalSession({
    controller: createWorkerProcessTransport({ capacity: 4 }),
    geometry: { columns: 80, rows: 24 },
  });
  const policy = createTerminalInputPolicy({ input });
  try {
    input.cancel();
    expect(read(display, policy, [new Uint8Array(1)])).toBe(-11);
  } finally {
    display.close("disposed");
  }
});

test("cooked CRLF state is shared across attachments", () => {
  const input = createTerminalInput({ capacity: 8 });
  const display = createTerminalSession({
    controller: createWorkerProcessTransport({ capacity: 4 }),
    geometry: { columns: 80, rows: 24 },
  });
  const first = createTerminalInputPolicy({ input });
  const second = createTerminalInputPolicy({ input });
  try {
    expect(input.push(new Uint8Array([65, 13]))).toBe(2);
    const cooked = new Uint8Array(2);
    expect(read(display, first, [cooked])).toBe(2);
    expect(Array.from(cooked)).toEqual([65, 10]);
    expect(read(display, second, [new Uint8Array(2)])).toBe(-6);
    expect(input.push(new Uint8Array([10]))).toBe(1);
    expect(read(display, second, [new Uint8Array(1)])).toBe(-6);
  } finally {
    display.close("disposed");
  }
});

test("large display input uses bounded turns without invalidating the session", () => {
  const input = createTerminalInput({ capacity: 8192 });
  const display = createTerminalSession({
    controller: createWorkerProcessTransport({ capacity: 4 }),
    geometry: { columns: 80, rows: 24 },
  });
  try {
    const bytes = new Uint8Array(4097).fill(65);
    expect(pushTerminalInput(display, input, bytes)).toEqual({ kind: "ok", value: 4097 });
    expect(input.available()).toBe(4097);
    expect(display.snapshot().kind).toBe("ok");
  } finally {
    display.close("disposed");
  }
});

test("generic input policy plugs into a foreground terminal endpoint", () => {
  const root = createWorkerProcessTransport({ capacity: 8 });
  const input = createTerminalInput({ capacity: 8 });
  const display = createTerminalSession({
    controller: root,
    geometry: { columns: 80, rows: 24 },
  });
  const policy = createTerminalInputPolicy({ input });
  const attachment = attachTerminal({
    context: display.inherit(),
    process: root,
    checkActive() {},
    policy,
  });
  const authority = must(
    claimTerminalAuthority({
      identity: display.identity,
      process: root,
      checkActive() {},
      policy,
    }),
  );
  const group = must(authority.createGroup({ initialMode: "cooked" }));
  must(authority.admitExisting({ group, pid: root.pid }));
  must(authority.acquire({ group, expected: null }));
  const stream = attachment.resolve(0);
  try {
    expect(input.push(new Uint8Array([97, 13]))).toBe(2);
    const bytes = new Uint8Array(2);
    expect(stream.tryRead?.([bytes])).toBe(2);
    expect(Array.from(bytes)).toEqual([97, 10]);
    expect(stream.tryRead?.([new Uint8Array(1)])).toBe(-6);
  } finally {
    attachment.dispose();
    display.close("disposed");
  }
});
