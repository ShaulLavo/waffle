import { expect, test } from "bun:test";
import baseline from "./fixtures/network-original-nodes.json";
import { networkParity } from "./network-source-parity.js";
function assertParity(text: string, expected: Record<string, string>): void {
  expect(networkParity(text, true)).toEqual(expected);
}

for (const [file, original] of Object.entries(baseline))
  test(`${file} preserves every original parsed node outside named hooks`, async () => {
    const actual = networkParity(await Bun.file(new URL(file, import.meta.url)).text(), true);
    for (const [node, hash] of Object.entries(original))
      expect(actual[node], `${file} unexpected node ${node}`).toBe(hash);
    expect(Object.keys(actual)).toEqual(Object.keys(original));
  });
for (const [from, to] of [
  ['"HTTP over service-worker preview and cross-worker TCP"', '"partial"'],
  ["response.status === 200", "response.status === 201"],
  ["n < 300", "n < 301"],
  ["setTimeout(resolve, 5)", "setTimeout(resolve, 6)"],
  ["() => item.retire()", "() => undefined"],
  [
    "if (registration) await serviceWorker.unregister(registration)",
    "if (registration) await serviceWorker.unregister(registration).catch(() => {})",
  ],
  ['() => navigator.serviceWorker.removeEventListener("message", route),', ""],
  ["() => isolatedNamespace.dispose(),", ""],
  ["() => runtime.dispose(),", ""],
  ["primary = { error };", "primary = undefined;"],
  ["() => isolatedNamespace.dispose(),", "() => runtime.dispose(),"],
] as const)
  test(`parity rejects network mutation ${from}`, async () => {
    const text = await Bun.file(new URL("./network-browser.ts", import.meta.url)).text();
    expect(text).toContain(from);
    expect(() => assertParity(text.replace(from, to), baseline["network-browser.ts"])).toThrow();
  });
for (const [from, to] of [
  ['["selected", "websocket", "bad-certificate"]', '["websocket"]'],
  ["fallbackMs < 15000", "fallbackMs < 16000"],
  ["await idle(environment);", ""],
  ["false, 2)", "false, 0)"],
] as const)
  test(`parity rejects relay mutation ${from}`, async () => {
    const text = await Bun.file(new URL("./network-relay-browser.ts", import.meta.url)).text();
    expect(text).toContain(from);
    expect(() =>
      assertParity(text.replace(from, to), baseline["network-relay-browser.ts"]),
    ).toThrow();
  });

for (const [file, from, to] of [
  ["network-browser.ts", "await serviceWorker.unregister(registration)", "void registration"],
  ["network-browser.ts", "throw error;", "return []"],
  [
    "network-relay-browser.ts",
    '["selected", "websocket", "bad-certificate"]',
    '["websocket", "selected", "bad-certificate"]',
  ],
  ["network-relay-modules.ts", '"RESET\\\\0aabcdef"', '"RESET\\\\0aother"'],
  ["network-relay-fixture.ts", "Date.now() + 15000", "Date.now() + 16000"],
  ["network-relay-fixture.ts", "await Bun.sleep(10)", "await Bun.sleep(11)"],
] as const)
  test(`parity rejects ${file} mutation ${from}`, async () => {
    const text = await Bun.file(new URL(file, import.meta.url)).text();
    expect(text).toContain(from);
    expect(() => assertParity(text.replace(from, to), baseline[file])).toThrow();
  });

test("parity rejects moving controller identity check after the original POST", async () => {
  const text = await Bun.file(new URL("./network-browser.ts", import.meta.url)).text();
  const guard = `    check(
      serviceWorker.controls(registration, navigator.serviceWorker.controller),
      "Preview controller identity changed",
    );
`;
  const post = `    const response = await fetch("/_net/32132/render?version=1", { method: "POST", body: payload });
`;
  expect(text).toContain(guard);
  expect(text).toContain(post);
  const changed = text.replace(guard, "").replace(post, post + guard);
  expect(() => assertParity(changed, baseline["network-browser.ts"])).toThrow();
});

test("parity rejects delaying cancellation until after the next listener acquisition", async () => {
  const text = await Bun.file(new URL("./network-relay-fixture.ts", import.meta.url)).text();
  const original = `      const echoPort = await listen(echo);
      signal?.throwIfAborted();
      const sslPort = await listen(ssl);`;
  const changed = `      const echoPort = await listen(echo);
      const sslPort = await listen(ssl);
      signal?.throwIfAborted();`;
  expect(text).toContain(original);
  expect(() =>
    assertParity(text.replace(original, changed), baseline["network-relay-fixture.ts"]),
  ).toThrow();
});
