import { afterEach, expect, test } from "bun:test";
import { ExecutableRegistry, type Executable } from "../proc/registry.js";
import { ProcessSupervisor } from "../proc/supervisor.js";
import { Signal, type ProcessContext, type SpawnRequest } from "../proc/types.js";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const request: SpawnRequest = {
  executable: "fixture",
  argv: [],
  env: {},
  cwd: "/",
  job: 0,
  fds: [],
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function fixture(loader: Executable["module"]) {
  const registry = new ExecutableRegistry();
  registry.register("fixture", { module: loader, adapter: "fixture" });
  const launched: ProcessContext[] = [];
  const supervisor = new ProcessSupervisor({
    registry,
    launch(context) {
      launched.push(context);
      context.started();
      context.exit(0);
      return { terminate() {} };
    },
  });
  cleanups.push(() => supervisor.dispose());
  return { registry, supervisor, launched, root: supervisor.createRoot() };
}

test.each(["synchronous", "asynchronous"])(
  "an explicit spawn retries after %s loader failure and caches success",
  async (failure) => {
    const unavailable = new Error("temporary module source unavailable");
    let available = false,
      loads = 0;
    const { supervisor, root, launched } = fixture(() => {
      loads++;
      if (available) return module;
      if (failure === "asynchronous") return Promise.reject(unavailable);
      throw unavailable;
    });
    const first = supervisor.spawn(root, request);
    await supervisor.start(first);
    expect(supervisor.wait(root, first)).toEqual({
      kind: "start-failed",
      error: "EIO",
      code: 5,
      status: null,
    });
    expect(loads).toBe(1);
    expect(launched).toHaveLength(0);

    available = true;
    const retry = supervisor.spawn(root, request);
    await supervisor.start(retry);
    expect(supervisor.wait(root, retry)).toEqual({ kind: "exited", code: 0, status: 0 });
    const cached = supervisor.spawn(root, request);
    await supervisor.start(cached);
    expect(supervisor.wait(root, cached)).toEqual({ kind: "exited", code: 0, status: 0 });
    expect(loads).toBe(2);
    expect(launched.map((context) => context.module)).toEqual([module, module]);
  },
);

test("concurrent names share each failed and retried attempt without changing rejection identity", async () => {
  const firstAttempt = Promise.withResolvers<WebAssembly.Module>();
  const retryAttempt = Promise.withResolvers<WebAssembly.Module>();
  const unavailable = { reason: "temporary module source unavailable" };
  let loads = 0;
  const { registry } = fixture(() => {
    loads++;
    return loads === 1 ? firstAttempt.promise : retryAttempt.promise;
  });
  const entry = await registry.check("fixture");
  if ("command" in entry) throw new Error("Expected a module entry");
  registry.register("alias", { ...entry, adapter: "alias", interruptible: true });
  const first = registry.resolve("fixture"),
    shared = registry.resolve("alias");
  firstAttempt.reject(unavailable);
  expect(await Promise.allSettled([first, shared])).toEqual([
    { status: "rejected", reason: unavailable },
    { status: "rejected", reason: unavailable },
  ]);
  await expect(first).rejects.toBe(unavailable);
  await expect(shared).rejects.toBe(unavailable);
  expect(loads).toBe(1);

  const retry = registry.resolve("fixture"),
    retryShared = registry.resolve("alias");
  retryAttempt.resolve(module);
  expect(await retry).toEqual({ kind: "module", module, adapter: "fixture", interruptible: false });
  expect(await retryShared).toEqual({
    kind: "module",
    module,
    adapter: "alias",
    interruptible: true,
  });
  expect((await registry.resolve("fixture")).module).toBe(module);
  expect(loads).toBe(2);
});

test("cancelling a retrying process preserves its peer's compilation and successful cache", async () => {
  const compilation = Promise.withResolvers<WebAssembly.Module>();
  const entered = Promise.withResolvers<void>();
  let loads = 0;
  const { supervisor, root, launched } = fixture(() => {
    loads++;
    if (loads === 1) throw new Error("temporary module source unavailable");
    entered.resolve();
    return compilation.promise;
  });
  const failed = supervisor.spawn(root, request);
  await supervisor.start(failed);
  expect(supervisor.wait(root, failed)?.kind).toBe("start-failed");

  const cancelled = supervisor.spawn(root, request),
    peer = supervisor.spawn(root, request);
  const starts = Promise.all([supervisor.start(cancelled), supervisor.start(peer)]);
  await entered.promise;
  supervisor.kill(cancelled, Signal.SIGKILL);
  compilation.resolve(module);
  await starts;
  expect(supervisor.wait(root, cancelled)).toEqual({ kind: "signaled", code: 9, status: 137 });
  expect(supervisor.wait(root, peer)).toEqual({ kind: "exited", code: 0, status: 0 });
  const cached = supervisor.spawn(root, request);
  await supervisor.start(cached);
  expect(supervisor.wait(root, cached)).toEqual({ kind: "exited", code: 0, status: 0 });
  expect(loads).toBe(2);
  expect(launched.map((context) => context.pid)).toEqual([peer, cached]);
});
