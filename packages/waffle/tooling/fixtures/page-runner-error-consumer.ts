import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeResult } from "waffle/testing/page-runner";
import { PlaywrightDriver } from "waffle/testing/page-runner/playwright";

for (const [specifier, suffix] of [
  ["waffle/testing/page-runner", "/tests/page-runner/consumer.ts"],
  ["waffle/testing/page-runner/playwright", "/tests/page-runner/playwright-driver.ts"],
]) {
  assert(specifier && suffix);
  const entry = import.meta.resolve(specifier);
  assert(entry.startsWith(pathToFileURL(resolve("node_modules/waffle")).href + "/"), entry);
  assert(entry.endsWith(suffix), entry);
}

function resource(reason: unknown, label: string, closed: string[]) {
  return {
    creation: Promise.resolve({
      close: async () => {
        closed.push(label);
        throw reason;
      },
    }),
    stopped: false,
  };
}

const scratch = await mkdtemp(join(tmpdir(), "waffle-installed-errors-"));
const driver = new PlaywrightDriver("firefox", scratch);
try {
  const closed: string[] = [];
  const leaf = Object.assign(new Error("transport leaf"), { code: "TRANSPORT_CLOSED" });
  const first = new Error("first observation", { cause: new Error("first observation cause") });
  const second = new AggregateError(
    [new Error("second observation child", { cause: leaf })],
    "second observation",
    { cause: new Error("second observation cause") },
  );
  const observations = new Map(
    [first, second].map(
      (reason, index) =>
        [
          String(index),
          {
            stop: async () => {
              closed.push(`observation ${index}`);
              throw reason;
            },
          },
        ] as const,
    ),
  );
  Reflect.set(driver, "observations", observations);
  const lifecycle: unknown = Reflect.get(driver, "lifecycle");
  assert(lifecycle && typeof lifecycle === "object");
  const context = new Error("context close", {
    cause: new Error("context cause", { cause: leaf }),
  });
  const browser = new AggregateError(
    [
      new Error("browser child one", { cause: leaf }),
      new Error("browser child two", { cause: 42 }),
    ],
    "browser close",
    { cause: new Error("browser cause") },
  );
  Reflect.set(lifecycle, "contexts", new Set([resource(context, "context", closed)]));
  Reflect.set(lifecycle, "browsers", new Set([resource(browser, "browser", closed)]));
  const stopping = driver.stop();
  assert.equal(driver.stop(), stopping);
  const cleanup = await stopping;
  assert.deepEqual(closed, ["observation 0", "observation 1", "context", "browser"]);
  assert.equal(cleanup.session.status, "unconfirmed");
  assert.deepEqual(cleanup.launcher, cleanup.session);
  const path = join(scratch, "result.json");
  const snapshot = structuredClone({ cleanup });
  await writeResult(path, snapshot);
  const saved: unknown = await Bun.file(path).json();
  assert.deepEqual(saved, snapshot);
  const expected = {
    name: "AggregateError",
    message: "Local browser cleanup failed",
    errors: [
      first,
      second,
      {
        name: "AggregateError",
        message: "Browser runner cleanup failed",
        errors: [context, browser],
      },
    ],
  };
  const expectedJSON = JSON.stringify(expected, (_key, value: unknown) => {
    if (!(value instanceof Error)) return value;
    return {
      name: value.name,
      message: value.message,
      ...("cause" in value ? { cause: value.cause } : {}),
      ...(value instanceof AggregateError ? { errors: value.errors } : {}),
    };
  });
  const actual = JSON.parse(
    cleanup.session.detail.split("; browser root ")[0]!,
    (key, value: unknown) => (key === "stack" || key === "code" ? undefined : value),
  );
  assert.deepEqual(actual, JSON.parse(expectedJSON));
  for (const message of [first, second, context, browser, leaf].map((error) => error.message))
    assert(cleanup.session.detail.includes(message), message);
  assert(cleanup.session.detail.includes('"code":"TRANSPORT_CLOSED"'));
  assert(cleanup.session.detail.includes('"stack":'));
  console.log("installed page-runner cleanup errors: pass");
} finally {
  try {
    await driver.stop();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
