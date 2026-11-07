import { requireWorkerAdapter } from "./gpu-browser-qualification.js";
import type { GpuAsyncEngine } from "./page-runner/gpu-async-request.js";
import { qualificationRecord } from "./fixtures/gpu/qualification-contract.js";

type AsyncPage = typeof import("./fixtures/gpu/async-page.js");
export type AsyncCommand = {
  invoke<K extends keyof AsyncPage>(name: K, args: Parameters<AsyncPage[K]>): Promise<unknown>;
  sleep(ms: number): Promise<void>;
};
function observation(result: unknown) {
  const value = qualificationRecord(result);
  if (typeof value.text !== "string" || !Array.isArray(value.errors))
    throw new Error("Invalid async guest observation");
  return { ...value, text: value.text, errors: value.errors };
}
function finished(result: unknown) {
  const value = observation(result),
    exit = qualificationRecord(qualificationRecord(result).exit);
  if (typeof exit.kind !== "string" || typeof exit.code !== "number")
    throw new Error("Invalid async guest exit");
  return { ...value, exit: { ...exit, kind: exit.kind, code: exit.code } };
}
async function marker(page: AsyncCommand, text: string, slot = 0, failure = false) {
  const deadline = Date.now() + 30_000;
  let last = "";
  while (Date.now() < deadline) {
    const observed = observation(await page.invoke("drainAsync", [slot]));
    last = observed.text;
    if (observed.errors.length)
      throw new Error(`Async host errors: ${JSON.stringify(observed.errors)}`);
    if (!failure && last.includes("GPU_ASYNC_FAIL"))
      throw new Error(`C assertion failed before ${text}: ${last}`);
    if (last.includes(text)) return observed;
    await page.sleep(20);
  }
  throw new Error(`C marker deadline for ${text}: ${last}`);
}
export function requireCompiledAsyncResult(result: unknown): void {
  const value = qualificationRecord(result),
    exit = qualificationRecord(value.exit);
  if (
    exit.kind !== "exited" ||
    exit.code !== 0 ||
    typeof value.text !== "string" ||
    !Array.isArray(value.errors) ||
    value.errors.length
  )
    throw new Error(`Compiled async guest failed: ${JSON.stringify(value)}`);
  for (const expected of [
    "GPU_ASYNC_NEGOTIATED granted=checked excessive=failed",
    "GPU_ASYNC_READBACK creation=exact zeros=preserved usages=unchanged",
    "GPU_ASYNC_REMAP initial=preserved partial=checked empty=consumed",
    "GPU_ASYNC_SCOPES mapped=validation invalid=validation dependent=validation recovered=yes",
    "GPU_ASYNC_COMPILATION native=error utf8=checked statuses=checked",
    "GPU_ASYNC_LOSS device=3 reason=2 message=",
    "GPU_ASYNC_ISOLATION destroyed=unmapped second-device=progress last-release=invalidated",
    "GPU_ASYNC_OK compiled=C runtime=blocking maps=exact scopes=native payload=once loss=explicit",
  ])
    if (!value.text.includes(expected))
      throw new Error(`Missing compiled result marker: ${expected}`);
  if (value.text.includes("GPU_ASYNC_FAIL"))
    throw new Error("A failed C assertion also claimed success");
}
async function complete(page: AsyncCommand, slot = 1) {
  await page.invoke("launchAsync", [[], slot]);
  await marker(page, "GPU_ASYNC_OK", slot);
  const result = finished(await page.invoke("finishAsync", [slot]));
  requireCompiledAsyncResult(result);
  return result;
}
async function lifecycle(page: AsyncCommand, stage: string, action: "kill" | "revoke") {
  await page.invoke("launchAsync", [
    action === "revoke" ? [`--pause-${stage}`, "--expect-revoke"] : [`--pause-${stage}`],
    0,
  ]);
  await marker(page, `GPU_ASYNC_PAUSED stage=${stage}`);
  await complete(page);
  if (action === "revoke") {
    await page.invoke("revokeAsync", [0]);
    await page.invoke("resumeAsync", [0]);
    await marker(page, `GPU_ASYNC_REVOKED stage=${stage}`, 0);
  }
  const stopped = finished(await page.invoke("finishAsync", [0, action === "kill"]));
  if (action === "kill" && (stopped.exit.kind !== "signaled" || stopped.exit.code !== 9))
    throw new Error("Compiled async kill did not select SIGKILL");
  if (stopped.errors.length) throw new Error("Lifecycle guest has host errors");
  if (action === "revoke") requireCompiledAsyncRevocation(stopped, stage);
  await complete(page);
  return {
    stage,
    action,
    status: "passed",
    compiledGuest: true,
    termination: { exit: stopped.exit, text: stopped.text, errors: stopped.errors },
  };
}
type NegativeControl =
  | "--suppress-writes"
  | "--corrupt-range"
  | "--reuse-payload"
  | "--malformed-map";
const negativeControls: readonly NegativeControl[] = [
  "--suppress-writes",
  "--corrupt-range",
  "--reuse-payload",
  "--malformed-map",
];
export function requireCompiledAsyncNegative(result: unknown, control: NegativeControl): void {
  const value = qualificationRecord(result),
    exit = qualificationRecord(value.exit);
  if (
    exit.kind !== "exited" ||
    exit.code !== 1 ||
    typeof value.text !== "string" ||
    value.text.includes("GPU_ASYNC_OK") ||
    !Array.isArray(value.errors) ||
    value.errors.length
  )
    throw new Error(`Invalid negative C result: ${control}`);
  const stage =
    control === "--suppress-writes"
      ? "exact-native-readback"
      : control === "--reuse-payload"
        ? "payload-once"
        : "completion-correlation";
  const lines = value.text.split(/\r?\n/);
  const failures = lines.filter((line) => line.startsWith("GPU_ASYNC_FAIL"));
  if (failures.length !== 1 || failures[0] !== `GPU_ASYNC_FAIL stage=${stage}`)
    throw new Error(`Wrong negative C assertion: ${control}`);
  const terminals = lines.filter((line) => line.startsWith("GPU_ASYNC_TERMINAL"));
  const protocol = control === "--corrupt-range" || control === "--malformed-map";
  if (
    protocol
      ? terminals.length !== 1 || terminals[0] !== "GPU_ASYNC_TERMINAL reason=2"
      : terminals.length !== 0
  )
    throw new Error(`Missing protocol terminal or unexpected terminal for ${control}`);
}
export function requireCompiledAsyncRevocation(result: unknown, stage: string): void {
  const value = qualificationRecord(result),
    exit = qualificationRecord(value.exit);
  if (
    !["map-pending", "payload-published", "work-pending"].includes(stage) ||
    exit.kind !== "exited" ||
    exit.code !== 0 ||
    typeof value.text !== "string" ||
    !Array.isArray(value.errors) ||
    value.errors.length ||
    value.text.includes("GPU_ASYNC_FAIL") ||
    value.text.includes("GPU_ASYNC_OK") ||
    value.text.includes("GPU_ASYNC_TERMINAL")
  )
    throw new Error("Invalid compiled revocation result");
  const lines = value.text.split(/\r?\n/);
  const paused = lines.filter((line) => line.startsWith("GPU_ASYNC_PAUSED"));
  const revoked = lines.filter((line) => line.startsWith("GPU_ASYNC_REVOKED"));
  const expected = new RegExp(
    `^GPU_ASYNC_REVOKED stage=${stage} errno=-64 repeated=2 append=-64 drained=(0|[1-9][0-9]*)$`,
  );
  const line = revoked[0];
  const match = revoked.length === 1 && line !== undefined ? expected.exec(line) : null;
  if (
    paused.length !== 1 ||
    paused[0] !== `GPU_ASYNC_PAUSED stage=${stage}` ||
    !match ||
    !Number.isSafeInteger(Number(match[1])) ||
    Number(match[1]) > 64
  )
    throw new Error("Missing exact compiled revocation proof");
}
async function negative(page: AsyncCommand, flag: NegativeControl) {
  await page.invoke("launchAsync", [[flag], 0]);
  await marker(page, "GPU_ASYNC_FAIL", 0, true);
  const result = finished(await page.invoke("finishAsync", [0]));
  requireCompiledAsyncNegative(result, flag);
  await complete(page);
  return {
    control: flag,
    status: "passed-negative-control",
    compiledGuest: true,
    text: result.text,
    result: { exit: result.exit, text: result.text, errors: result.errors },
  };
}
function assertAdapterIdentity(text: string, adapter: Record<string, unknown>): void {
  for (const field of ["vendor", "architecture"]) {
    const identity = adapter[field];
    if (typeof identity === "string" && !text.includes(`${field}=${identity}`))
      throw new Error(`Compiled adapter identity differs for ${field}`);
  }
}
export async function runAsyncSuite(page: AsyncCommand, adapter: Record<string, unknown>) {
  await page.invoke("openAsync", []);
  try {
    const normal = await complete(page);
    assertAdapterIdentity(normal.text, adapter);
    const negatives = [],
      lifetimes = [];
    for (const flag of negativeControls) negatives.push(await negative(page, flag));
    for (const stage of ["map-pending", "payload-published", "work-pending"]) {
      lifetimes.push(await lifecycle(page, stage, "kill"));
      lifetimes.push(await lifecycle(page, stage, "revoke"));
    }
    const retired = qualificationRecord(await page.invoke("asyncServiceSnapshot", []));
    if (retired.connections !== 0 || retired.devicesLive !== 0 || retired.heapBytes !== 0)
      throw new Error(`Compiled async service retained resources: ${JSON.stringify(retired)}`);
    return { status: "passed", compiledGuest: true, normal, negatives, lifetimes, retired };
  } finally {
    await page.invoke("closeAsync", []);
  }
}

export function requireCompleteAsyncResult(
  result: unknown,
  adapter: Record<string, unknown>,
): void {
  const value = qualificationRecord(result);
  const normal = observation(value.normal);
  requireCompiledAsyncResult(normal);
  assertAdapterIdentity(normal.text, adapter);
  if (
    value.status !== "passed" ||
    value.compiledGuest !== true ||
    !Array.isArray(value.negatives) ||
    value.negatives.length !== negativeControls.length ||
    !Array.isArray(value.lifetimes) ||
    value.lifetimes.length !== 6
  )
    throw new Error("Missing complete compiled async scenarios");
  for (const [index, flag] of negativeControls.entries()) {
    const negative = qualificationRecord(value.negatives[index]);
    if (
      negative.control !== flag ||
      negative.status !== "passed-negative-control" ||
      negative.compiledGuest !== true
    )
      throw new Error("Wrong compiled async negative order");
    requireCompiledAsyncNegative(negative.result, flag);
  }
  for (const [index, stage] of ["map-pending", "payload-published", "work-pending"].entries()) {
    requireLifetime(value.lifetimes[index * 2], stage, "kill");
    requireLifetime(value.lifetimes[index * 2 + 1], stage, "revoke");
  }
  const retired = qualificationRecord(value.retired);
  if (retired.connections !== 0 || retired.devicesLive !== 0 || retired.heapBytes !== 0)
    throw new Error("Compiled async service retained resources");
}
function requireLifetime(result: unknown, stage: string, action: "kill" | "revoke"): void {
  const value = qualificationRecord(result);
  if (
    value.stage !== stage ||
    value.action !== action ||
    value.status !== "passed" ||
    value.compiledGuest !== true
  )
    throw new Error("Wrong compiled async lifetime order");
  const stopped = finished(value.termination);
  if (stopped.errors.length) throw new Error("Lifecycle guest has host errors");
  if (action === "kill" && (stopped.exit.kind !== "signaled" || stopped.exit.code !== 9))
    throw new Error("Compiled async kill did not select SIGKILL");
  if (action === "revoke") requireCompiledAsyncRevocation(stopped, stage);
}

export function admitAsync(engine: GpuAsyncEngine, qualification: unknown) {
  const observed = qualificationRecord(qualificationRecord(qualification).capabilities);
  // Reuse the stock optional-adapter policy, not a WebKit capability observation.
  const available = requireWorkerAdapter(engine === "ios-safari" ? "webkit" : engine, observed);
  const adapter = qualificationRecord(observed.adapter);
  if (engine === "chromium" && adapter.architecture !== "swiftshader")
    throw new Error(`Wrong Chromium adapter: ${JSON.stringify(adapter)}`);
  return { available, adapter };
}
