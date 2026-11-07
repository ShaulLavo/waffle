import { qualificationRecord } from "./qualification-contract.js";
import {
  assertWake,
  defaultMeasurementOptions,
  distribution,
  measure,
  measurementOptions,
  unavailableMemory,
  type MeasurementOptions,
  type MeasurementRequest,
} from "./measurement-contract.js";

type OwnedWorker = { worker: Worker; startupMs: number; stopped: boolean };
const owned = new Set<OwnedWorker>();
function stop(owner: OwnedWorker) {
  if (owner.stopped) return;
  owner.worker.terminate();
  owner.stopped = true;
  owned.delete(owner);
}
function readyMessage(
  data: unknown,
  finish: () => void,
  resolve: () => void,
  reject: (error: unknown) => void,
) {
  finish();
  try {
    const ready = qualificationRecord(data);
    if (
      ready.kind !== "ready" ||
      ready.realm !== "dedicated-worker" ||
      ready.hasDocument !== false ||
      ready.isolated !== true
    )
      throw new Error("Worker realm/isolation positive control failed");
    resolve();
  } catch (error) {
    reject(error);
  }
}
function workerReady(owner: OwnedWorker, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Worker startup deadline")), timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      owner.worker.onmessage = null;
      owner.worker.onerror = null;
    };
    owner.worker.onerror = (event) => {
      finish();
      reject(new Error(event.message));
    };
    owner.worker.onmessage = (event: MessageEvent<unknown>) =>
      readyMessage(event.data, finish, resolve, reject);
  });
}
async function openWorker(timeoutMs: number): Promise<OwnedWorker> {
  const start = performance.now();
  const owner = {
    worker: new Worker("/measurement-worker.js", { type: "module" }),
    startupMs: 0,
    stopped: false,
  };
  owned.add(owner);
  try {
    await workerReady(owner, timeoutMs);
    owner.startupMs = performance.now() - start;
    return owner;
  } catch (error) {
    stop(owner);
    throw error;
  }
}
function replyMessage({
  data,
  done,
  fail,
  resolve,
  armed,
}: {
  data: unknown;
  done: () => void;
  fail: (error: unknown) => void;
  resolve: (value: unknown) => void;
  armed?: () => void;
}) {
  try {
    const reply = qualificationRecord(data);
    if (reply.kind === "armed") {
      armed?.();
      return;
    }
    done();
    if (reply.kind !== "reply") throw new Error(String(reply.error));
    resolve(reply.value);
  } catch (error) {
    fail(error);
  }
}
function request(
  owner: OwnedWorker,
  message: MeasurementRequest,
  timeoutMs: number,
  armed?: () => void,
): Promise<unknown> {
  if (owner.stopped) throw new Error("Measurement worker stopped");
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      owner.worker.onmessage = null;
      owner.worker.onerror = null;
    };
    const fail = (error: unknown) => {
      done();
      stop(owner);
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`Worker ${message.kind} deadline`)), timeoutMs);
    owner.worker.onerror = (event) => fail(new Error(event.message));
    owner.worker.onmessage = (event: MessageEvent<unknown>) =>
      replyMessage({ data: event.data, done, fail, resolve, armed });
    try {
      owner.worker.postMessage(message);
    } catch (error) {
      fail(error);
    }
  });
}
async function wake(
  owner: OwnedWorker,
  options: MeasurementOptions,
  notifier: "page" | "worker",
): Promise<Record<string, unknown>> {
  const control = new SharedArrayBuffer(16);
  const cells = new Int32Array(control, 0, 2);
  let notified = 0,
    start = 0;
  const reply = qualificationRecord(
    await request(
      owner,
      { kind: "wait", control, timeoutMs: options.timeoutMs / 2, notifier },
      options.timeoutMs,
      () => {
        start = performance.now();
        if (notifier === "worker") {
          owner.worker.postMessage({ kind: "notify" });
          return;
        }
        Atomics.store(cells, 0, 1);
        notified = Atomics.notify(cells, 0);
      },
    ),
  );
  const roundTripMs = performance.now() - start;
  return {
    ...reply,
    elapsedMs: notifier === "page" ? roundTripMs : reply.elapsedMs,
    notified: notifier === "page" ? notified : reply.notified,
  };
}
async function wakes(owner: OwnedWorker, options: MeasurementOptions) {
  const samples: number[] = [],
    roundtrips: number[] = [];
  for (let trial = 0; trial < options.warmup + options.trials; trial++) {
    const same = await wake(owner, options, "worker");
    const cross = await wake(owner, options, "page");
    if (same.negativeControl !== "not-equal" || cross.negativeControl !== "not-equal")
      throw new Error("Missing waitAsync negative control");
    const elapsed = assertWake(same),
      roundTrip = assertWake(cross);
    if (trial < options.warmup) continue;
    samples.push(elapsed);
    roundtrips.push(roundTrip);
  }
  return {
    sameWorkerNotifyToContinuation: distribution(samples),
    crossThreadNotifyToReplyUpperBound: distribution(roundtrips),
    notEqualControl: "not-equal",
    clock:
      "Single-realm performance.now for each distribution. Same-worker excludes arming message; cross-thread includes worker reply postMessage overhead and is an upper bound, not isolated wake latency.",
    notifiedWaitersEachTrial: 1,
  };
}
async function closeWorker(owner: OwnedWorker, timeoutMs: number) {
  if (owner.stopped)
    return { terminatedOnFailure: true, deviceDestroyAcknowledgement: "unavailable" };
  try {
    const value = qualificationRecord(await request(owner, { kind: "dispose" }, timeoutMs));
    if (
      value.destroyed !== true ||
      value.devicesLive !== 0 ||
      value.buffersLive !== 0 ||
      value.canvasesLive !== 0
    )
      throw new Error(`Native measurement cleanup failed: ${JSON.stringify(value)}`);
    return value;
  } finally {
    stop(owner);
  }
}
async function extraDevices(options: MeasurementOptions) {
  const cohort: OwnedWorker[] = [];
  const devices: unknown[] = [];
  const retired: unknown[] = [];
  try {
    for (let index = 0; index < options.extraWorkers; index++) {
      const owner = await openWorker(options.timeoutMs);
      cohort.push(owner);
      devices.push({
        observedAt: new Date().toISOString(),
        workerStartupMs: owner.startupMs,
        device: await request(owner, { kind: "device" }, options.timeoutMs),
      });
    }
  } finally {
    for (const owner of cohort) retired.push(await closeWorker(owner, options.timeoutMs));
  }
  return {
    requested: options.extraWorkers,
    devices,
    retired,
    scope: "Bounded native extra-worker/device sample, not a maximum-device-count test",
    physicalMemory: unavailableMemory(),
  };
}
async function nativeDeviceMeasurements(owner: OwnedWorker, options: MeasurementOptions) {
  const capabilities = await measure(() => request(owner, { kind: "probe" }, options.timeoutMs));
  const device = qualificationRecord(await request(owner, { kind: "device" }, options.timeoutMs));
  const wakeLatency =
    typeof Atomics.waitAsync === "function"
      ? await measure(() => wakes(owner, options))
      : { kind: "unsupported", reason: "Atomics.waitAsync unavailable in page" };
  if (device.kind !== "measured")
    return {
      workerStartupMs: owner.startupMs,
      capabilities,
      device,
      wakeLatency,
      sabUpload: device,
      image1080p: device,
      image4k: device,
    };
  const sabUpload = await request(
    owner,
    { kind: "upload", options, corrupt: false },
    options.timeoutMs,
  );
  const uploadControl = qualificationRecord(
    await request(owner, { kind: "upload", options, corrupt: true }, options.timeoutMs),
  );
  if (uploadControl.kind !== "failed" || !String(uploadControl.reason).includes("readback differs"))
    throw new Error("Corrupt-readback negative control did not fail its oracle");
  const imageControl = qualificationRecord(
    await request(
      owner,
      { kind: "image", options, width: 1920, height: 1080, suppress: true },
      options.timeoutMs,
    ),
  );
  if (imageControl.kind !== "failed" || !String(imageControl.reason).includes("pixel differs"))
    throw new Error(
      `Suppressed image transfer negative control did not fail its oracle: ${JSON.stringify(imageControl)}`,
    );
  const image1080p = await request(
    owner,
    { kind: "image", options, width: 1920, height: 1080, suppress: false },
    options.timeoutMs,
  );
  const image4k = await request(
    owner,
    { kind: "image", options, width: 3840, height: 2160, suppress: false },
    options.timeoutMs,
  );
  return {
    workerStartupMs: owner.startupMs,
    capabilities,
    device,
    wakeLatency,
    sabUpload,
    uploadControl,
    imageControl,
    image1080p,
    image4k,
  };
}
async function nativeMeasurements(options: MeasurementOptions) {
  const owner = await openWorker(options.timeoutMs);
  try {
    const result = await nativeDeviceMeasurements(owner, options);
    const cleanup = await closeWorker(owner, options.timeoutMs);
    return { ...result, cleanup };
  } finally {
    stop(owner);
  }
}
/** @browserEntry */
export async function runGpuMeasurement(input: unknown = defaultMeasurementOptions) {
  if (owned.size) throw new Error("Measurement already active");
  const options = measurementOptions(input);
  try {
    const native = await measure(() => nativeMeasurements(options));
    const extraWorkerDevices = await measure(() => extraDevices(options));
    return {
      schema: "waffle-gpu-measure-v1",
      time: new Date().toISOString(),
      environment: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        crossOriginIsolated,
        hardwareConcurrency: navigator.hardwareConcurrency,
        physicalMemory: unavailableMemory(),
      },
      options,
      native,
      extraWorkerDevices,
      qualification:
        "Native diagnostic measurements only. Hardware/browser/OS identification comes from the host runner. No G0.3 qualification claim.",
      remaining: {
        lightGuestFairness: {
          kind: "unmet",
          reason:
            "Requested desktop comparison is reported separately by the portable runner using real compiled 20,000 and 50,000-draw modes. No page-authored stream substitute.",
        },
        replayPerDraw: {
          kind: "unmet",
          reason: "See the portable runner desktopFairness result when explicitly requested.",
        },
        physicalIphoneDeviceCount: {
          kind: "unmet",
          reason: "No physical iPhone run. Extra desktop workers do not establish iOS limits.",
        },
      },
    };
  } finally {
    for (const owner of owned) stop(owner);
  }
}
/** @browserEntry */
export function measurementResources() {
  return { workersLive: owned.size };
}
