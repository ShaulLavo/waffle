import { record, formatHostError, type HostVerdict } from "./protocol.js";
import type { Reporter } from "./reporter.js";
import type { Configuration } from "./page-main.js";

export type HostPageRun<R> = {
  kind: "host";
  teardown(request: R, verdict: HostVerdict): Promise<unknown>;
};
type HookOutcome =
  | { status: "pass"; result: unknown }
  | { status: "fail"; error: string }
  | { status: "timeout"; error: string; settled: boolean };
type Receiver = {
  phase: "admitting" | "ready" | "driving" | "teardown" | "terminal";
  verdict(value: unknown): void;
  task(operation: string, source: string): void;
  allocateDatabase(operation: string, name: string): void;
};
declare global {
  interface Window {
    __hostCase: Receiver;
  }
}
function verdict(value: unknown): HostVerdict {
  if (!record(value)) throw new Error("Invalid host verdict");
  if (value.status === "fail" && typeof value.error === "string")
    return { status: "fail", error: value.error };
  if (value.status === "pass" && "result" in value) return { status: "pass", result: value.result };
  throw new Error("Invalid host verdict");
}
function dispatchTask(reporter: Reporter, source: string): Promise<unknown> {
  const result = Promise.withResolvers<unknown>();
  reporter.clock.timeout(() => {
    try {
      result.resolve(new Function(`return (async () => {${source}\n})()`)());
    } catch (error) {
      result.reject(error);
    }
  }, 0);
  return result.promise;
}
function receiver(
  reporter: Reporter,
  caseId: string,
  resolve: (value: HostVerdict) => void,
): Receiver {
  const operations = new Set<string>();
  let running = false;
  const state: Receiver = {
    phase: "admitting",
    verdict(value) {
      if (state.phase !== "driving") throw new Error("Duplicate or out-of-phase verdict");
      const accepted = verdict(value);
      state.phase = "teardown";
      resolve(accepted);
    },
    task(operation, source) {
      startTask(operation, () => dispatchTask(reporter, source));
    },
    allocateDatabase(operation, name) {
      startTask(operation, () =>
        reporter.send({ kind: "allocation", entry: { kind: "indexeddb", name } }),
      );
    },
  };
  function startTask(operation: string, start: () => Promise<unknown>): void {
    if (state.phase !== "driving" || running || operations.has(operation))
      throw new Error("Duplicate or out-of-phase task");
    operations.add(operation);
    running = true;
    const task = start();
    void task
      .then(
        () => reportTask(operation, "pass"),
        (error: unknown) => reportTask(operation, "fail", formatHostError(error)),
      )
      .catch(() => {});
  }
  function reportTask(operation: string, status: "pass" | "fail", error?: string): Promise<void> {
    running = false;
    return reporter.send({ kind: "task-end", caseId, operation, status, error });
  }
  return state;
}
async function hook<R>(
  run: HostPageRun<R>,
  request: R,
  body: HostVerdict,
  reporter: Reporter,
  ms: number,
): Promise<HookOutcome> {
  const clock = reporter.clock;
  const until = clock.now() + ms;
  const timed = Promise.withResolvers<HookOutcome>();
  const timer = clock.timeout(
    () => timed.resolve({ status: "timeout", error: "Page teardown timed out", settled: false }),
    ms,
  );
  let operation: Promise<unknown>;
  let synchronousFailure = "";
  try {
    operation = Promise.resolve(run.teardown(request, body));
  } catch (error) {
    synchronousFailure = formatHostError(error);
    operation = Promise.reject(error);
  }
  const observation: { outcome: HookOutcome | null } = { outcome: null };
  const observe = (outcome: HookOutcome): HookOutcome => {
    observation.outcome = outcome;
    return outcome;
  };
  const settlement = operation.then(
    (result) =>
      observe(
        clock.now() >= until
          ? { status: "timeout", error: "Page teardown timed out", settled: true }
          : { status: "pass", result },
      ),
    (error: unknown) =>
      observe(
        clock.now() >= until
          ? { status: "timeout", error: formatHostError(error), settled: true }
          : { status: "fail", error: formatHostError(error) },
      ),
  );
  try {
    if (clock.now() >= until) {
      await Promise.resolve();
      return (
        observation.outcome ?? {
          status: "timeout",
          settled: false,
          error: `Page teardown timed out${synchronousFailure ? `; ${synchronousFailure}` : ""}`,
        }
      );
    }
    return await Promise.race([settlement, timed.promise]);
  } finally {
    clock.clearTimeout(timer);
  }
}
export async function runHostPage<R>(
  config: Extract<Configuration<R>, { role: "case" }>,
  run: HostPageRun<R>,
  reporter: Reporter,
  snapshot: (value: unknown) => unknown,
): Promise<void> {
  const body = Promise.withResolvers<HostVerdict>();
  const state = receiver(reporter, config.caseId, body.resolve);
  window.__hostCase = state;
  await reporter.send({ kind: "case-ready", caseId: config.caseId });
  state.phase = "ready";
  const accepted = await body.promise;
  const entering = reporter.send({ kind: "case-teardown", caseId: config.caseId });
  const teardown = await hook(run, config.request, accepted, reporter, config.teardownMs ?? 60_000);
  state.phase = "terminal";
  await entering;
  const status = accepted.status === "pass" && teardown.status === "pass" ? "pass" : "fail";
  const error = [
    accepted.status === "fail" ? accepted.error : "",
    teardown.status !== "pass" ? teardown.error : "",
  ]
    .filter(Boolean)
    .join("; ");
  await reporter.send({
    kind: "case-end",
    caseId: config.caseId,
    status,
    error,
    result: snapshot({ body: accepted, teardown }),
  });
}
