import { expect, test } from "bun:test";

async function failureCase(selected: string) {
  const child = Bun.spawn(
    ["bun", new URL("./threads-runtime-failure-control.ts", import.meta.url).pathname, selected],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const output = await new Response(child.stdout).text();
    const errors = await new Response(child.stderr).text();
    expect(await child.exited, errors).toBe(0);
    return JSON.parse(output.trim());
  } finally {
    child.kill();
    await child.exited;
  }
}

test("thread adapter cleanup failure keeps the same fenced backing as debt and runs once", async () => {
  const report = await failureCase("adapter-cleanup");
  expect(report.serviceConstructors).toBe(1);
  expect(report.guestConstructors).toBe(1);
  expect(report.cleanupCalls).toBe(1);
  expect(report.nativeThreadStops).toBe(2);
  expect(report.nativeThreadReturns).toBe(2);
  expect(report.observation).toEqual({ kind: "terminated" });
  expect(report.disposal.kind).toBe("error");
  expect(report.repeatedDisposal.kind).toBe("error");
  expect(report.sharedGuests).toHaveLength(1);
  expect(report.sharedGuests[0]).toMatchObject({
    phase: "debt",
    fence: "passed",
    chargedBytes: 33554432,
    aliases: { reserved: 0, transferred: 0, retained: 0 },
  });
}, 15000);

test("a no-Worker thread start failure is collectable and disposes repeatedly", async () => {
  const report = await failureCase("service-constructor");
  expect(report.serviceConstructors).toBe(1);
  expect(report.guestConstructors).toBe(0);
  expect(report.exit).toMatchObject({
    kind: "value",
    value: { kind: "start-failed", error: "EIO" },
  });
  expect(report.cleanupCalls).toBe(1);
  expect(report.disposal.kind).toBe("value");
  expect(report.repeatedDisposal.kind).toBe("value");
  expect(report.children).toEqual([]);
  expect(report.collected).toEqual(report.exit.value);
  expect(report.repeatedWait).toBe(12);
  expect(
    report.sharedGuests.every(
      (backing: { phase: string }) => backing.phase === "awaiting-collection",
    ),
  ).toBe(true);
}, 15000);

test("failure after native Worker construction is not a no-agent rollback", async () => {
  const report = await failureCase("service-handler");
  expect(report.serviceConstructors).toBe(1);
  expect(report.guestConstructors).toBe(0);
  expect(report.disposal.kind).toBe("error");
  expect(report.sharedGuests).toHaveLength(1);
  expect(report.sharedGuests[0].phase).toBe("debt");
}, 15000);

test("real Runtime terminal revocation prevents a delayed successful file read from publishing", async () => {
  const report = await failureCase("late-read");
  expect(report.publication).toEqual({
    revoked: { kind: "value", value: true },
    byte: { kind: "value", value: 91 },
  });
  expect(report.exit).toMatchObject({ kind: "value", value: { kind: "signaled", code: 9 } });
  expect(report.disposal.kind).toBe("value");
  expect(report.repeatedDisposal.kind).toBe("value");
}, 15000);

test("failed no-Worker rollback retains its heap debt and does not repeat adapter cleanup", async () => {
  const report = await failureCase("service-constructor-cleanup");
  expect(report.serviceConstructors).toBe(1);
  expect(report.guestConstructors).toBe(0);
  expect(report.cleanupCalls).toBe(1);
  expect(report.disposal.kind).toBe("error");
  expect(report.repeatedDisposal.kind).toBe("error");
  expect(report.sharedGuests).toHaveLength(1);
  expect(report.sharedGuests[0].phase).toBe("debt");
}, 15000);

for (const name of ["toString", "toLocaleString", "valueOf", "unsupported_zero"]) {
  test(`unsupported source ${name} is refused before threaded allocation`, async () => {
    const report = await failureCase(`unsupported-${name}`);
    expect(report.serviceConstructors).toBe(0);
    expect(report.guestConstructors).toBe(0);
    expect(report.sharedGuests).toEqual([]);
    expect(report.exit).toMatchObject({
      kind: "value",
      value: { kind: "start-failed", error: "ENOEXEC" },
    });
  }, 15000);
}
for (const selected of ["network-thread", "network-opaque", "network-ordinary-failure"]) {
  test(`${selected} releases its actual network helper exactly once on refusal`, async () => {
    const report = await failureCase(selected);
    expect(report.serviceConstructors).toBe(0);
    expect(report.guestConstructors).toBe(0);
    expect(report.ordinaryConstructors).toBe(selected === "network-ordinary-failure" ? 1 : 0);
    expect(report.helperBeforeLaunch).toBe("live");
    expect(report.disposesAfterRefusal).toBe(1);
    expect(report.networkDisposes).toBe(1);
    expect(report.helperAfterRefusal).toBe("disposed");
    expect(report.children).toHaveLength(selected === "network-ordinary-failure" ? 1 : 0);
    expect(report.sharedGuests).toEqual([]);
    expect(report.disposal.kind).toBe("value");
  }, 15000);
}
