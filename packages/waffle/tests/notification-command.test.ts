import { expect, test } from "bun:test";

const calls = [
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
  "mixed", "terminated", "revoked", "startupCancel", "releaseFailure", "sendFailure",
  "relayStopFailure", "relayArmFailure", "startupReject",
];
async function body(): Promise<string> {
  const source = await Bun.file(new URL("./notification-browser-runner.ts", import.meta.url)).text();
  const start = source.indexOf("await page.evaluate(async () => {");
  const end = source.indexOf("\n  });", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return new Bun.Transpiler({ loader: "ts" }).transformSync(
    `async function command() {${source.slice(start + "await page.evaluate(async () => {".length, end)}\n}`,
  );
}
async function execute(failAt = -1) {
  const observed: unknown[][] = [];
  const imported: string[] = [];
  const module = Object.fromEntries(Array.from(new Set(calls.map(([name]) => String(name))), (name) => [
    name,
    async (...args: unknown[]) => {
      observed.push([name].concat(args));
      await Promise.resolve();
      if (observed.length - 1 === failAt) throw new Error(`original failure ${failAt}`);
      return { step: observed.length };
    },
  ]));
  const load = async (path: string) => {
    imported.push(path);
    if (path !== "/mixed.js" && path !== "/lifetime.js") throw new Error(`Wrong import ${path}`);
    return module;
  };
  const run = new Function("load", "location", `${(await body()).replaceAll("import(", "load(")}\nreturn command();`);
  const actual: unknown = await run(load, { href: "https://notification.invalid/owned?token=original" });
  return { actual, observed, imported };
}
const expectedCalls = calls.map(([name, ...args]) => [name].concat(args.map((arg) =>
  typeof arg === "string" && arg.startsWith("/") ? `https://notification.invalid${arg}` : arg,
)));
test("the complete notification command preserves nine original calls, arguments and order", async () => {
  const { actual, observed, imported } = await execute();
  expect(imported).toEqual(["/mixed.js", "/lifetime.js"]);
  expect(observed).toEqual(expectedCalls);
  expect(actual).toEqual(Object.fromEntries(labels.map((label, index) => [label, { step: index + 1 }])));
  expect(Object.keys(Object(actual))).toEqual(labels);
});
for (let index = 0; index < calls.length; index++) {
  test(`original notification failure ${labels[index]} rejects the command`, async () => {
    await expect(execute(index)).rejects.toThrow(`original failure ${index}`);
  });
}
