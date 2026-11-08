import { expect, test } from "bun:test";
import { finishNetworkCase } from "./network-finalizer.js";
import { formatHostError } from "./page-runner/protocol.js";

const order = ["guest 1", "guest 2", "unregister", "listener", "namespace", "runtime"];
for (const primary of [undefined, new Error("PRIMARY_ASSERTION")])
  for (const failed of [
    "unregister refusal",
    "unregister rejection",
    "guest 1",
    "guest 2",
    "listener",
    "namespace",
    "runtime",
    "all",
  ])
    test(`${failed} attempts all original cleanup with ${primary ? "primary" : "no primary"}`, async () => {
      const calls: string[] = [];
      const disposers = order.map((label) => async () => {
        calls.push(label);
        if (
          failed === "all" ||
          failed === label ||
          (label === "unregister" && failed.startsWith(label))
        )
          throw new Error(`CLEANUP_${label}_${failed}`);
      });
      let caught: unknown;
      try {
        await finishNetworkCase(primary ? { error: primary } : undefined, disposers);
      } catch (error) {
        caught = error;
      }
      expect(calls).toEqual(order);
      expect(caught).toBeInstanceOf(AggregateError);
      if (!(caught instanceof AggregateError)) throw new Error("Lost cleanup failures");
      const errors: unknown[] = caught.errors;
      expect(errors.length).toBe((failed === "all" ? order.length : 1) + (primary ? 1 : 0));
      if (primary) expect(errors[0]).toBe(primary);
      const diagnostic = formatHostError(caught);
      if (primary)
        expect(diagnostic.indexOf("PRIMARY_ASSERTION")).toBeLessThan(
          diagnostic.indexOf("CLEANUP_"),
        );
      for (const error of errors) expect(diagnostic).toContain(String(error));
    });
test("falsy cleanup errors survive and a successful finalizer does not replace the body", async () => {
  await expect(
    finishNetworkCase(undefined, [
      () => {
        throw undefined;
      },
      () => {
        throw null;
      },
    ]),
  ).rejects.toBeInstanceOf(AggregateError);
  await expect(
    finishNetworkCase({ error: new Error("primary") }, [() => {}]),
  ).resolves.toBeUndefined();
});
