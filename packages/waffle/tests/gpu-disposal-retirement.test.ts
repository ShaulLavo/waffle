import { expect, spyOn, test } from "bun:test";
import { GpuService } from "../browser/gpu/service.js";
import { GpuScheduler, type GpuConnection } from "../browser/gpu/scheduler.js";
import type { GpuServiceRequest, GpuServiceReply } from "../browser/display/service-protocol.js";
import type { GraphicsOpen } from "../browser/display/protocol.js";
import { gpuPayloadLayout } from "../browser/display/generated/graphics-layout.js";
import { serviceAccess } from "./fixtures/gpu/service-access.js";
import { deferred, settle } from "./fixtures/gpu/core-fixture.js";
import { disposalRetirementReady } from "./fixtures/gpu/disposal-retirement.js";

const task = () => new Promise<void>((resolve) => setImmediate(resolve));
function open(): GraphicsOpen {
  return {
    type: "open",
    id: 1,
    control: new SharedArrayBuffer(64),
    commands: new SharedArrayBuffer(4160),
    replies: new SharedArrayBuffer(4160),
    arena: new SharedArrayBuffer(gpuPayloadLayout.byteLength),
  };
}
for (const order of [
  [1, 2],
  [2, 1],
])
  test(`disposal audit waits for actual cleanup and all grant acknowledgements (${order.join(",")})`, async () => {
    const owners = order.map((grant) => ({ open: { grant }, retiredAck: false }));
    const connections = new Map<number, GpuConnection>();
    const events: string[] = [];
    const held = deferred<number>();
    let receiving = 0;
    const add = GpuScheduler.prototype.add;
    const observer = spyOn(GpuScheduler.prototype, "add").mockImplementation(function (
      this: GpuScheduler,
      connection,
    ) {
      connections.set(receiving, connection);
      return add.call(this, connection);
    });
    const audit = (message: GpuServiceRequest | GpuServiceReply) => {
      if (!disposalRetirementReady(message, owners, 2)) return;
      expect(service.snapshot()).toMatchObject({ connections: 0, devicesLive: 0, heapBytes: 0 });
      events.push("retired");
      held.resolve(42);
    };
    const service = new GpuService(
      (message) => {
        if (message.type === "retired") {
          const owner = owners.find((owner) => owner.open.grant === message.grant);
          if (!owner) throw new Error("unknown grant");
          owner.retiredAck = true;
        }
        audit(message);
      },
      { access: serviceAccess(), root: {} },
    );
    try {
      for (const owner of owners) {
        receiving = owner.open.grant;
        service.receive({ type: "open", grant: receiving, open: open(), surfaces: [] });
      }
      connections.get(2)!.completions.start(
        1,
        () => held.promise,
        () => {
          throw new Error("live native callback");
        },
        () => {
          throw new Error("unexpected native error");
        },
        (value) => {
          expect(value).toBe(42);
          events.push("late");
        },
      );
      for (const grant of [2, 1]) {
        const message = { type: "revoke", grant } as const;
        service.receive(message);
        audit(message);
      }
      await settle();
      expect(events).toEqual([]);
      for (let n = 0; n < 20 && events.length < 2; n++) await task();
      expect(owners.every((owner) => owner.retiredAck)).toBe(true);
      expect(events).toEqual(["retired", "late"]);
      expect(service.snapshot()).toMatchObject({ connections: 0, devicesLive: 0, heapBytes: 0 });
    } finally {
      await service.dispose();
      held.resolve(42);
      await settle();
      observer.mockRestore();
    }
  });

test("disposal audit rejects request-only, unknown, partial and missing-selected retirement", () => {
  const owners = [
    { open: { grant: 1 }, retiredAck: true },
    { open: { grant: 2 }, retiredAck: false },
  ];
  expect(disposalRetirementReady({ type: "revoke", grant: 2 }, owners, 2)).toBe(false);
  expect(disposalRetirementReady({ type: "retired", grant: 2 }, owners, 2)).toBe(false);
  owners[1]!.retiredAck = true;
  expect(disposalRetirementReady({ type: "retired", grant: 99 }, owners, 2)).toBe(false);
  expect(disposalRetirementReady({ type: "retired", grant: 2 }, owners, 99)).toBe(false);
  expect(disposalRetirementReady({ type: "retired", grant: 2 }, owners, undefined)).toBe(false);
  expect(disposalRetirementReady({ type: "retired", grant: 2 }, [], 2)).toBe(false);
  expect(disposalRetirementReady({ type: "retired", grant: 2 }, owners, 2)).toBe(true);
});
