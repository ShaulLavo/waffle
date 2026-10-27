import { expect, test } from "bun:test";
import { mixedNotificationCases } from "./notification-mixed-cases.js";

test("real blocked Worker composes filesystem, network and process notifications", async () => {
  const result = await mixedNotificationCases(
    new URL("./fixtures/notification-mixed-worker.ts", import.meta.url).href,
    new URL("../browser/notification-worker.ts", import.meta.url).href,
  );
  console.log(JSON.stringify({ mixed: result }));
  expect(result).toMatchObject({ done: true });
}, 15000);

import {
  bootstrapNotificationCase,
  brokerNotificationCase,
  scopeDisposalFailureCase,
  scopeSendFailureCase,
} from "./notification-lifetime-cases.js";

const runtimeWorker = new URL("./fixtures/notification-runtime-worker.ts", import.meta.url).href;
const helperWorker = new URL("../browser/notification-worker.ts", import.meta.url).href;
for (const revoke of [false, true])
  test(`broker externally owns real Worker termination and joined disposal, revoke=${revoke}`, async () => {
    const result = await brokerNotificationCase(runtimeWorker, helperWorker, revoke);
    console.log(JSON.stringify({ lifetime: result }));
    expect(result).toMatchObject({ joined: true });
  }, 10000);

for (const mode of ["arm", "reject"] as const)
  test(`real bootstrap ${mode} cancellation settles without guest entry`, async () => {
    const helper =
      mode === "arm"
        ? new URL("./fixtures/notification-stalled-worker.ts", import.meta.url).href
        : helperWorker;
    expect(await bootstrapNotificationCase(runtimeWorker, helper, mode)).toMatchObject({
      entries: 0,
      cleanups: 1,
    });
  }, 10000);

test("relay rejection still attempts guest physical termination", async () => {
  expect(await brokerNotificationCase(runtimeWorker, helperWorker, false, true)).toMatchObject({
    joined: true,
    relayFailure: true,
  });
}, 10000);

for (const detachPort of [false, true])
  test(`scope disposal settles pending arm after throwing release/send, detached=${detachPort}`, async () => {
    const helper = new URL("./fixtures/notification-stalled-worker.ts", import.meta.url).href;
    expect(await scopeDisposalFailureCase(helper, detachPort)).toMatchObject({
      releases: 1,
      closed: true,
    });
  }, 10000);

test("real bootstrap relay error reply rejects startup without guest entry", async () => {
  const helper = new URL("./fixtures/notification-reject-worker.ts", import.meta.url).href;
  expect(await bootstrapNotificationCase(runtimeWorker, helper, "relay")).toMatchObject({
    entries: 0,
    cleanups: 1,
  });
}, 10000);

test("scope disposal closes its real port after a throwing send and settles pending startup", async () => {
  const helper = new URL("./fixtures/notification-stalled-worker.ts", import.meta.url).href;
  const module = new URL("./fixtures/notification-send-failure-worker.ts", import.meta.url).href;
  expect(await scopeSendFailureCase(module, helper)).toMatchObject({ sendFailed: true, closes: 1 });
}, 10000);
