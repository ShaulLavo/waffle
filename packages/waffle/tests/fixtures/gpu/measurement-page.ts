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
async function openWorker(timeoutMs: number): Promise<OwnedWorker> {
  const start = performance.now();
  const owner = {
    worker: new Worker("/measurement-worker.js", { type: "module" }),
    startupMs: 0,
    stopped: false,
  };
  owned.add(owner);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Worker startup deadline")), timeoutMs);
      const done = () => {
        clearTimeout(timer);
        owner.worker.onmessage = null;
        owner.worker.onerror = null;
      };
      owner.worker.onerror = (event) => {
        done();
        reject(new Error(event.message));
      };
      owner.worker.onmessage = (event: MessageEvent<unknown>) => {
        done();
        const ready = qualificationRecord(event.data);
        if (
          ready.kind !== "ready" ||
          ready.realm !== "dedicated-worker" ||
          ready.hasDocument !== false ||
          ready.isolated !== true
        )
          reject(new Error("Worker realm/isolation positive control failed"));
        else resolve();
      };
    });
    owner.startupMs = performance.now() - start;
    return owner;
  } catch (error) {
    stop(owner);
    throw error;
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
    owner.worker.onmessage = (event: MessageEvent<unknown>) => {
      try {
        const reply = qualificationRecord(event.data);
        if (reply.kind === "armed") {
          armed?.();
          return;
        }
        done();
        if (reply.kind === "reply") resolve(reply.value);
        else fail(new Error(String(reply.error)));
      } catch (error) {
        fail(error);
      }
    };
    try {
      owner.worker.postMessage(message);
    } catch (error) {
      fail(error);
    }
  });
}
async function wake(owner: OwnedWorker, options: MeasurementOptions, notify: boolean) {
  const control = new SharedArrayBuffer(16);
  const cells = new Int32Array(control, 0, 2);
  let notified = 0;
  const reply = qualificationRecord(
    await request(
      owner,
      { kind: "wait", control, timeoutMs: notify ? options.timeoutMs / 2 : 20 },
      options.timeoutMs,
      () => {
        new Float64Array(control, 8, 1)[0] = performance.timeOrigin + performance.now();
        if (!notify) return;
        Atomics.store(cells, 0, 1);
        notified = Atomics.notify(cells, 0);
      },
    ),
  );
  return { ...reply, notified };
}
async function wakes(owner: OwnedWorker, options: MeasurementOptions) {
  const negative = qualificationRecord(await wake(owner, options, false));
  if (negative.async !== true || negative.result !== "timed-out" || negative.notified !== 0)
    throw new Error("waitAsync no-notify control failed");
  const samples: number[] = [];
  for (let trial = 0; trial < options.warmup + options.trials; trial++) {
    const elapsed = assertWake(await wake(owner, options, true));
    if (trial >= options.warmup) samples.push(elapsed);
  }
  return {
    wake: distribution(samples),
    noNotifyControl: negative.result,
    clock:
      "performance.timeOrigin + performance.now across page and worker; timer precision applies; includes wake dispatch, excludes postMessage arming",
    notifiedWaitersEachTrial: 1,
  };
}
async function closeWorker(owner: OwnedWorker, timeoutMs: number) {
  try {
    return await request(owner, { kind: "dispose" }, timeoutMs);
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
async function nativeMeasurements(options: MeasurementOptions) {
  const owner = await openWorker(options.timeoutMs);
  try {
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
    if (
      uploadControl.kind !== "failed" ||
      !String(uploadControl.reason).includes("readback differs")
    )
      throw new Error("Corrupt-readback negative control did not fail its oracle");
    const imageControl = qualificationRecord(
      await request(
        owner,
        { kind: "image", options, width: 1920, height: 1080, suppress: true },
        options.timeoutMs,
      ),
    );
    if (imageControl.kind !== "failed" || !String(imageControl.reason).includes("pixel differs"))
      throw new Error("Suppressed image transfer negative control did not fail its oracle");
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
  } finally {
    await closeWorker(owner, options.timeoutMs);
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
            "Requires real compiled 20,000–50,000-draw guest workload and caps-on/off comparison; G1 workload not implemented. No page-authored stream substitute.",
        },
        replayPerDraw: {
          kind: "unmet",
          reason: "Requires the real compiled high-draw guest workload.",
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
