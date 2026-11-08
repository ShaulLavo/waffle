import { expect, test } from "bun:test";
import { notificationCommand, notificationSources } from "./notification-command.js";

const calls: [string, ...(string | boolean)[]][] = [
  ["mixedNotificationCases", "/guest.js", "/helper.js"],
  ["brokerNotificationCase", "/runtime.js", "/helper.js", false],
  ["brokerNotificationCase", "/runtime.js", "/helper.js", true],
  ["bootstrapNotificationCase", "/runtime.js", "/stalled.js", "arm"],
  ["scopeDisposalFailureCase", "/stalled.js", false],
  ["scopeDisposalFailureCase", "/stalled.js", true],
  ["brokerNotificationCase", "/runtime.js", "/helper.js", false, true],
  ["bootstrapNotificationCase", "/runtime.js", "/reject.js", "relay"],
  ["bootstrapNotificationCase", "/runtime.js", "/helper.js", "reject"],
];
const labels = [
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

function scenarioStub(name: string, observed: unknown[][], failAt: number) {
  return async (...args: unknown[]) => {
    const call: unknown[] = [name];
    observed.push(call.concat(args));
    await Promise.resolve();
    if (observed.length - 1 === failAt) throw new Error(`original failure ${failAt}`);
    return { step: observed.length };
  };
}
async function execute(failAt = -1, observed: unknown[][] = []) {
  const imported: string[] = [];
  const module = Object.fromEntries(
    Array.from(new Set(calls.map(([name]) => name)), (name) => [
      name,
      scenarioStub(name, observed, failAt),
    ]),
  );
  const load = async (path: string) => {
    imported.push(path);
    if (path !== "/mixed.js" && path !== "/lifetime.js") throw new Error(`Wrong import ${path}`);
    return module;
  };
  const run = new Function(
    "load",
    "location",
    `return (${notificationCommand.toString().replaceAll("import(", "load(")})();`,
  );
  const actual: unknown = await run(load, {
    href: "https://notification.invalid/owned?token=original",
  });
  return { actual, observed, imported };
}
const expectedCalls = calls.map(([name, ...args]) => {
  const call: unknown[] = [name];
  return call.concat(
    args.map((arg) =>
      typeof arg === "string" && arg.startsWith("/") ? `https://notification.invalid${arg}` : arg,
    ),
  );
});
test("the complete notification command preserves nine original calls, arguments and order", async () => {
  const { actual, observed, imported } = await execute();
  expect(imported).toEqual(["/mixed.js", "/lifetime.js"]);
  expect(observed).toEqual(expectedCalls);
  expect(actual).toEqual(
    Object.fromEntries(labels.map((label, index) => [label, { step: index + 1 }])),
  );
  expect(Object.keys(Object(actual))).toEqual(labels);
});
for (let index = 0; index < calls.length; index++) {
  test(`original notification failure ${labels[index]} rejects the command`, async () => {
    const observed: unknown[][] = [];
    await expect(execute(index, observed)).rejects.toThrow(`original failure ${index}`);
    expect(observed).toEqual(expectedCalls.slice(0, index + 1));
  });
}

test("stock and hosted commands use the shared complete function and original seven assets", async () => {
  const source = await Bun.file(
    new URL("./notification-browser-runner.ts", import.meta.url),
  ).text();
  expect(source).toContain("new Map(Object.entries(notificationSources))");
  expect(source).toContain('const commandPath = "/notification.js"');
  expect(source).toContain("return command.notificationCommand()");
  expect(source).toContain("const deadline = setTimeout(stop, 60000)");
  expect(notificationSources).toEqual({
    "/notification.js": "notification-command.ts",
    "/mixed.js": "notification-mixed-cases.ts",
    "/lifetime.js": "notification-lifetime-cases.ts",
    "/guest.js": "fixtures/notification-mixed-worker.ts",
    "/runtime.js": "fixtures/notification-runtime-worker.ts",
    "/stalled.js": "fixtures/notification-stalled-worker.ts",
    "/reject.js": "fixtures/notification-reject-worker.ts",
    "/helper.js": "../browser/notification-worker.ts",
  });
});
