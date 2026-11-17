import { expect, mock, test } from "bun:test";
import { createLoadRecovery } from "../../../docs/examples/asset-load-recovery.ts";

function fixture() {
  const saved = new Map<string, string>();
  const storage = {
    getItem: mock((key: string): string | null => saved.get(key) ?? null),
    setItem: mock((key: string, value: string) => {
      saved.set(key, value);
    }),
  };
  const options = {
    storage: () => storage,
    preserve: mock(async () => {}),
    navigate: mock(() => {}),
    showFailure: mock(() => {}),
  };
  const recovery = createLoadRecovery(options);
  const cause = new TypeError("module fetch failed");
  const failure = { kind: "lazy-service", resource: "network", cause } as const;
  return { recovery, options, storage, failure };
}

test("load rejection preserves its cause, reports once, and does not navigate or retry", async () => {
  const { recovery, options, failure } = fixture();
  const load = mock(async () => {
    throw failure.cause;
  });
  await expect(recovery.load("network", load)).rejects.toBe(failure.cause);
  recovery.report(failure);
  expect(options.showFailure).toHaveBeenCalledTimes(1);
  expect(options.showFailure).toHaveBeenCalledWith(failure);
  expect(load).toHaveBeenCalledTimes(1);
  expect(options.navigate).not.toHaveBeenCalled();
  expect(options.preserve).not.toHaveBeenCalled();
});

test("a successful guest result is not a load failure", async () => {
  const { recovery, options } = fixture();
  expect(await recovery.load("process service", async () => ({ exitCode: 1 }))).toEqual({
    exitCode: 1,
  });
  expect(options.showFailure).not.toHaveBeenCalled();
  expect(await recovery.reload()).toBe("blocked");
});

test("a throwing presenter cannot replace the original load rejection", async () => {
  const { recovery, options, failure } = fixture();
  const displayError = new Error("failure display failed");
  options.showFailure.mockImplementation(() => {
    throw displayError;
  });
  const load = mock(async () => {
    throw failure.cause;
  });
  await expect(recovery.load("network", load)).rejects.toBe(failure.cause);
  recovery.report(failure);
  expect(options.showFailure).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledTimes(1);
  expect(options.navigate).not.toHaveBeenCalled();
  expect(options.preserve).not.toHaveBeenCalled();
});

test("duplicate recovery requests preserve once and persist the guard before navigation", async () => {
  const { recovery, options, failure, storage } = fixture();
  let release!: () => void;
  options.preserve.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  options.navigate.mockImplementation(() => {
    expect(storage.getItem("waffle:load-recovery-attempted")).toBe("attempted");
  });
  recovery.report(failure);
  const first = recovery.reload();
  expect(recovery.reload()).toBe(first);
  expect(options.navigate).not.toHaveBeenCalled();
  release();
  expect(await first).toBe("navigating");
  expect(options.preserve).toHaveBeenCalledTimes(1);
  expect(options.navigate).toHaveBeenCalledTimes(1);
  const afterReload = createLoadRecovery(options);
  afterReload.report(failure);
  expect(await afterReload.reload()).toBe("blocked");
  expect(options.navigate).toHaveBeenCalledTimes(1);
});

test("failed preservation retains its error without navigation or a guard write", async () => {
  const { recovery, options, failure, storage } = fixture();
  const flushError = new Error("quota exceeded");
  options.preserve.mockRejectedValue(flushError);
  recovery.report(failure);
  await expect(recovery.reload()).rejects.toBe(flushError);
  await expect(recovery.reload()).rejects.toBe(flushError);
  expect(options.navigate).not.toHaveBeenCalled();
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(options.preserve).toHaveBeenCalledTimes(1);
});

for (const operation of ["access", "read", "write", "readback"] as const) {
  test(`guard ${operation} failure blocks navigation`, async () => {
    const { recovery, options, failure, storage } = fixture();
    const denied = () => {
      throw new Error("storage denied");
    };
    if (operation === "access") options.storage = denied;
    if (operation === "read") storage.getItem.mockImplementation(denied);
    if (operation === "write") storage.setItem.mockImplementation(denied);
    if (operation === "readback") storage.setItem.mockImplementation(() => {});
    recovery.report(failure);
    expect(await recovery.reload()).toBe("blocked");
    expect(await recovery.reload()).toBe("blocked");
    expect(options.navigate).not.toHaveBeenCalled();
  });
}
