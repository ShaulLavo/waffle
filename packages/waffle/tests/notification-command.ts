import { record } from "./page-runner/protocol.js";

export const notificationSources = {
  "/notification.js": "notification-command.ts",
  "/mixed.js": "notification-mixed-cases.ts",
  "/lifetime.js": "notification-lifetime-cases.ts",
  "/guest.js": "fixtures/notification-mixed-worker.ts",
  "/runtime.js": "fixtures/notification-runtime-worker.ts",
  "/stalled.js": "fixtures/notification-stalled-worker.ts",
  "/reject.js": "fixtures/notification-reject-worker.ts",
  "/helper.js": "../browser/notification-worker.ts",
};

export async function notificationCommand() {
  const mixedPath = "/mixed.js",
    lifetimePath = "/lifetime.js";
  const mixed: typeof import("./notification-mixed-cases.js") = await import(mixedPath);
  const lifetime: typeof import("./notification-lifetime-cases.js") = await import(lifetimePath);
  const url = (path: string) => new URL(path, location.href).href;
  return {
    mixed: await mixed.mixedNotificationCases(url("/guest.js"), url("/helper.js")),
    terminated: await lifetime.brokerNotificationCase(url("/runtime.js"), url("/helper.js"), false),
    revoked: await lifetime.brokerNotificationCase(url("/runtime.js"), url("/helper.js"), true),
    startupCancel: await lifetime.bootstrapNotificationCase(
      url("/runtime.js"),
      url("/stalled.js"),
      "arm",
    ),
    releaseFailure: await lifetime.scopeDisposalFailureCase(url("/stalled.js"), false),
    sendFailure: await lifetime.scopeDisposalFailureCase(url("/stalled.js"), true),
    relayStopFailure: await lifetime.brokerNotificationCase(
      url("/runtime.js"),
      url("/helper.js"),
      false,
      true,
    ),
    relayArmFailure: await lifetime.bootstrapNotificationCase(
      url("/runtime.js"),
      url("/reject.js"),
      "relay",
    ),
    startupReject: await lifetime.bootstrapNotificationCase(
      url("/runtime.js"),
      url("/helper.js"),
      "reject",
    ),
  };
}

const scenarioNames = [
  "mixed",
  "terminated",
  "revoked",
  "startupCancel",
  "releaseFailure",
  "sendFailure",
  "relayStopFailure",
  "relayArmFailure",
  "startupReject",
];
export function checkNotificationResult(result: unknown): void {
  if (!record(result) || JSON.stringify(Object.keys(result)) !== JSON.stringify(scenarioNames))
    throw new Error("Notification command requires all nine original scenarios in order");
  checkMixed(result.mixed);
  checkBroker(result.terminated, false, false);
  checkBroker(result.revoked, true, false);
  checkBootstrap(result.startupCancel, "arm", 0);
  checkDisposal(result.releaseFailure, false);
  checkDisposal(result.sendFailure, true);
  checkBroker(result.relayStopFailure, false, true);
  checkBootstrap(result.relayArmFailure, "relay", 1);
  checkBootstrap(result.startupReject, "reject", 0);
}
function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function sample(
  value: unknown,
): value is { sequence: number; filesystem: number; network: number; process: number } {
  return (
    record(value) &&
    ["sequence", "filesystem", "network", "process"].every((key) => counter(value[key]))
  );
}
function checkMixed(value: unknown): void {
  if (
    !record(value) ||
    value.done !== true ||
    !Array.isArray(value.reports) ||
    value.reports.length !== 8 ||
    !counter(value.turns) ||
    value.turns >= 8
  )
    throw new Error("Incomplete mixed notification result");
  const stages = [
    "fs-service",
    "fs-service-parked",
    "fs-direct",
    "fs-direct-parked",
    "network",
    "network-parked",
    "process",
    "process-parked",
  ];
  value.reports.forEach((report: unknown, index: number) => checkReport(report, stages[index]));
}
function checkReport(value: unknown, stage: string | undefined): void {
  if (
    !stage ||
    !record(value) ||
    value.stage !== stage ||
    !sample(value.before) ||
    !sample(value.after)
  )
    throw new Error(`Incomplete mixed notification report ${stage}`);
  const source = stage.startsWith("fs-")
    ? "filesystem"
    : stage.startsWith("network")
      ? "network"
      : "process";
  if (
    value.before[source] === value.after[source] ||
    (!stage.endsWith("-parked") &&
      source !== "filesystem" &&
      value.before.filesystem !== value.after.filesystem) ||
    (stage.endsWith("-parked") && (!counter(value.turns) || value.turns < 1 || value.turns >= 8))
  )
    throw new Error(`Wrong mixed notification publication ${stage}`);
}
function checkBroker(value: unknown, revoke: boolean, relayFailure: boolean): void {
  if (
    !record(value) ||
    value.revoke !== revoke ||
    value.externalClosed !== 1 ||
    value.guestCleanups !== 0 ||
    value.hostCleanups !== 1 ||
    value.joined !== true ||
    value.relayFailure !== relayFailure ||
    !Array.isArray(value.terminationOrder)
  )
    throw new Error("Incomplete broker notification result");
  const order: unknown[] = value.terminationOrder;
  if (
    order.length !== 4 ||
    !order.every(termination) ||
    new Set(order.map((event) => event.id)).size !== 4
  )
    throw new Error("Incomplete notification Worker termination order");
  const processes = order.filter((event) => event.worker !== "unused");
  const unused = order.filter((event) => event.worker === "unused");
  if (
    unused.length !== 2 ||
    unused.some((event) => event.requests !== 0) ||
    processes.length !== 2 ||
    processes[0]?.worker !== "helper" ||
    processes[1]?.worker !== "guest" ||
    processes.some((event) => event.requests !== 1 || !event.fenced)
  )
    throw new Error("Wrong notification Worker termination order");
}
function termination(
  value: unknown,
): value is { id: number; worker: string; requests: number; fenced: boolean } {
  return (
    record(value) &&
    counter(value.id) &&
    counter(value.requests) &&
    typeof value.worker === "string" &&
    ["helper", "guest", "unused"].includes(value.worker) &&
    typeof value.fenced === "boolean"
  );
}
function checkBootstrap(value: unknown, mode: string, relayReply: number): void {
  if (
    !record(value) ||
    value.mode !== mode ||
    value.entries !== 0 ||
    value.cleanups !== 1 ||
    value.relayReply !== relayReply
  )
    throw new Error(`Incomplete notification bootstrap ${mode}`);
}
function checkDisposal(value: unknown, detachPort: boolean): void {
  if (
    !record(value) ||
    value.detachPort !== detachPort ||
    value.releases !== 1 ||
    value.closed !== true ||
    value.pendingArmRejected !== true
  )
    throw new Error("Incomplete notification scope disposal");
}
