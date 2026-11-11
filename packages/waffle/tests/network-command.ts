import { mkdir, realpath, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  nativeMain,
  runPageSuite,
  writeResult,
  type Driver,
  type SuiteAdapter,
} from "waffle/testing/page-runner";
import { networkAdapter, relayAdapter } from "./network-page-suite.js";
import { networkInputs } from "./network-page-inputs.js";
import type { NetworkTarget } from "./network-page-contract.js";

type Phase = {
  target: NetworkTarget;
  phase: "network" | "relay";
  evidence: string;
  result: unknown;
  confirmed: boolean;
  exit: number;
};
export type NetworkCommandOptions = {
  resultPath?: string;
  startedAt?: number;
  signal?: AbortSignal;
  driver?: (target: Exclude<NetworkTarget, "ios-safari">, scratch: string) => Driver;
};
export function networkPort(): number | "ephemeral" {
  const value = Number(process.env.NETWORK_TEST_PORT ?? 43827);
  if (value === 0) return "ephemeral";
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535)
    throw new Error("NETWORK_TEST_PORT must be 0 or a port from 1024 through 65535");
  return value;
}
export function networkTargets(names: readonly string[]): NetworkTarget[] {
  if (!names.length) throw new Error("No network targets selected");
  return names.map((name) => {
    if (name === "chromium" || name === "firefox" || name === "webkit" || name === "ios-safari")
      return name;
    throw new Error(`Unknown network target: ${name}`);
  });
}
export async function networkScratch(): Promise<string> {
  const root = resolve(
    process.env.NETWORK_SCRATCH_ROOT ?? process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(),
  );
  await mkdir(root, { recursive: true });
  if (Buffer.byteLength(await realpath(root)) > 36)
    throw new Error("NETWORK_SCRATCH_ROOT must be physically short for browser Unix sockets");
  return root;
}
export async function completeNetworkCommand(
  names: readonly NetworkTarget[],
  options: NetworkCommandOptions = {},
  relayOnly = false,
): Promise<number> {
  const startedAt = options.startedAt ?? performance.now();
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason ?? "Network command interrupted");
  const deadline = setTimeout(
    () => controller.abort("Network command deadline exceeded"),
    Math.max(0, 600_000 - (performance.now() - startedAt)),
  );
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const phases: Phase[] = [];
  const inputs = networkInputs();
  let resultPath = options.resultPath;
  try {
    const scratchRoot = await networkScratch();
    resultPath ??= join(scratchRoot, `network-command-${crypto.randomUUID()}.json`);
    const port = networkPort();
    const run = async (target: NetworkTarget, phase: Phase["phase"], stamp: number) => {
      controller.signal.throwIfAborted();
      const adapter = phase === "network" ? networkAdapter(inputs) : relayAdapter(inputs, target);
      const evidence =
        names.length === 1
          ? `${resultPath}.${phase}.json`
          : `${resultPath}.${target}.${phase}.json`;
      const result = await runPhase(
        adapter,
        target,
        {
          resultPath: evidence,
          scratchRoot,
          startedAt: stamp,
          port: phase === "network" ? port : "ephemeral",
          signal: controller.signal,
        },
        options.driver,
      );
      phases.push({ target, phase, evidence, ...result });
      return result.exit;
    };
    const networkStartedAt = performance.now();
    for (const target of relayOnly ? [] : names) {
      if (await run(target, "network", networkStartedAt)) return await finish(false);
    }
    let relayStartedAt = performance.now();
    for (const target of names) {
      await run(target, "relay", relayStartedAt);
      relayStartedAt = performance.now();
    }
    return await finish(!relayOnly);
  } catch (error) {
    if (!resultPath) throw error;
    await writeResult(resultPath, {
      suite: "network-command",
      complete: false,
      exit: 2,
      phases,
      failure: String(error),
    });
    console.log(
      JSON.stringify({
        command: "network-browser",
        complete: false,
        exit: 2,
        resultPath,
        phases: failedPhases(phases),
        failure: String(error),
      }),
    );
    return 2;
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    options.signal?.removeEventListener("abort", abort);
  }
  async function finish(whole: boolean): Promise<number> {
    let exit =
      phases.find((phase) => phase.exit !== 0)?.exit ?? (controller.signal.aborted ? 2 : 0);
    const complete =
      whole &&
      exit === 0 &&
      phases.length === names.length * 2 &&
      phases.every((phase) => phase.confirmed);
    if (whole && !complete && exit === 0) exit = 2;
    await writeResult(resultPath!, { suite: "network-command", complete, exit, phases });
    console.log(
      JSON.stringify({
        command: "network-browser",
        complete,
        exit,
        resultPath,
        ...(!complete && { phases: failedPhases(phases) }),
      }),
    );
    return exit;
  }
}
function failedPhases(phases: readonly Phase[]) {
  return phases
    .filter((phase) => phase.exit !== 0 || !phase.confirmed)
    .map((phase) => {
      const { target, exit, confirmed, result } = phase;
      if (!result || typeof result !== "object")
        return { target, phase: phase.phase, exit, confirmed, result };
      const value = Object.fromEntries(Object.entries(result));
      const entries = (field: unknown, include: (item: unknown) => boolean) =>
        field && typeof field === "object"
          ? Object.fromEntries(Object.entries(field).filter(([, item]) => include(item)))
          : undefined;
      const status = (item: unknown) =>
        item && typeof item === "object" && "status" in item ? item.status : undefined;
      return {
        target,
        phase: phase.phase,
        exit,
        confirmed,
        result: {
          runComplete: value.runComplete,
          omitted: value.omitted,
          failures: value.failures,
          failure: value.failure,
          precondition: value.precondition,
          outcomes: entries(
            value.outcomes,
            (item) =>
              status(item) !== "pass" ||
              (typeof item === "object" &&
                item !== null &&
                "provisional" in item &&
                item.provisional === true),
          ),
          cleanup: entries(value.cleanup, (item) => status(item) === "unconfirmed"),
        },
      };
    });
}
async function runPhase(
  adapter: SuiteAdapter<null>,
  target: NetworkTarget,
  options: Parameters<typeof runPageSuite>[2],
  supplied: NetworkCommandOptions["driver"],
): Promise<{ result: unknown; confirmed: boolean; exit: number }> {
  if (target === "ios-safari") {
    await writeResult(options.resultPath, {
      suite: adapter.suite,
      exit: 2,
      runComplete: false,
      failure: "Phase has not returned confirmed evidence",
    });
    const exit = await nativeMain(adapter, ["--result", options.resultPath], options);
    try {
      const result: unknown = JSON.parse(await readFile(options.resultPath, "utf8"));
      return { exit, result, confirmed: completePhase(result) };
    } catch {
      return { exit, result: null, confirmed: false };
    }
  }
  const create = supplied ?? (await desktopDriver());
  const result = await runPageSuite(adapter, (scratch) => create(target, scratch), options);
  return { result, exit: result.exit, confirmed: completePhase(result) };
}
function completePhase(value: unknown): boolean {
  if (
    !value ||
    typeof value !== "object" ||
    !("exit" in value) ||
    value.exit !== 0 ||
    !("runComplete" in value) ||
    value.runComplete !== true ||
    !("omitted" in value) ||
    !Array.isArray(value.omitted) ||
    value.omitted.length !== 0 ||
    !("cleanup" in value) ||
    !value.cleanup ||
    typeof value.cleanup !== "object"
  )
    return false;
  const cleanup = value.cleanup;
  return ["session", "launcher", "server", "storage", "scratch", "fixture", "callbacks"].every(
    (key) => {
      const step: unknown = Object.getOwnPropertyDescriptor(cleanup, key)?.value;
      return (
        step !== null &&
        typeof step === "object" &&
        "status" in step &&
        (step.status === "confirmed" || step.status === "not-created")
      );
    },
  );
}
async function desktopDriver(): Promise<NonNullable<NetworkCommandOptions["driver"]>> {
  const { NetworkDesktopDriver } = await import("./network-desktop-driver.js");
  return (target, scratch) => new NetworkDesktopDriver(target, scratch);
}
export async function nativeNetworkCommand(args: string[], startedAt: number): Promise<number> {
  const path = args[1];
  if (args.length !== 2 || args[0] !== "--result" || !path || !isAbsolute(path)) {
    console.error("Usage: network-browser ios-safari --result /absolute/result.json");
    return 3;
  }
  if (
    process.platform !== "darwin" ||
    !process.env.IOS_UDID ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(process.env.IOS_UDID)
  ) {
    await writeResult(path, {
      suite: "network-command",
      exit: 3,
      complete: false,
      phases: [],
      precondition: "Darwin and exact IOS_UDID required; no native resources allocated",
    });
    return 3;
  }
  return completeNetworkCommand(["ios-safari"], { resultPath: path, startedAt });
}
