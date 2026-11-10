import { join } from "node:path";
import type { HostCase, SuiteAdapter } from "waffle/testing/page-runner";
import {
  keyControlId,
  keyControls,
  checkKeyControlResult,
  checkKeyEdges,
  checkKeyEffect,
  sameKeyEffect,
  type KeyEffect,
} from "./key-press-observation.js";

import { record } from "./protocol.js";
async function drive(host: HostCase, reference: readonly KeyEffect[]): Promise<unknown> {
  const observations: unknown[] = [];
  for (const mode of ["default", "prevent", "decoy"]) {
    const target = mode === "decoy" ? "decoy" : "primary";
    for (const [index, item] of keyControls.entries()) {
      await host.task(
        `window.__keyControl.setup(${JSON.stringify(target)},${JSON.stringify(item.value)},${item.position},${mode === "prevent"});`,
      );
      if (mode === "decoy") await rejectWrongFocus(host);
      await host.script(`window.__keyControl.assertFocus(${JSON.stringify(target)});`);
      await host.press(item.key);
      const snapshot = await host.script("return window.__keyControl.snapshot();");
      checkKeyEdges(snapshot, item.key, target, mode === "prevent");
      checkKeyEffect(snapshot, item.key, item.value, item.position, mode === "prevent");
      const original = reference[index];
      if (mode !== "prevent" && original) sameKeyEffect(snapshot, original);
      observations.push(snapshot);
    }
  }
  const sequence = await continuousKeys(host);
  return { observations, sequence };
}
async function rejectWrongFocus(host: HostCase): Promise<void> {
  try {
    await host.script("window.__keyControl.assertFocus('primary');");
  } catch (error) {
    if (String(error).includes("Wrong focused key target")) return;
    throw error;
  }
  throw new Error("Consumer focus assertion did not reject the decoy");
}
export function keyPressAdapter(reference: readonly KeyEffect[] = []): SuiteAdapter<null> {
  return {
    suite: "key-press-controls",
    inventory: () => [
      {
        id: keyControlId,
        label: "four native keys",
        request: () => null,
        drive: (host) => drive(host, reference),
      },
    ],
    policy: {
      listIds(value) {
        if (
          !record(value) ||
          !Array.isArray(value.ids) ||
          value.ids.length !== 1 ||
          value.ids[0] !== keyControlId
        )
          throw new Error("Wrong key control inventory");
        return [keyControlId];
      },
      requireResult: true,
      check: (_id, value) => checkKeyControlResult(value),
    },
    async assets() {
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, "key-press-control-page.ts")],
        target: "browser",
      });
      if (!built.success || !built.outputs[0])
        throw new AggregateError(built.logs, "Key control page build failed");
      return { "/page.js": built.outputs[0] };
    },
    budgets: () => ({
      hello: 10_000,
      heartbeat: 10_000,
      case: 60_000,
      operation: 15_000,
      teardown: 5000,
      caseDocument: 90_000,
      group: 90_000,
      run: 120_000,
    }),
  };
}

async function continuousKeys(host: HostCase): Promise<unknown[]> {
  await host.task("window.__keyControl.setup('primary','first\\nsecond\\nthird',17,false);");
  const sequence: unknown[] = [];
  for (const item of keyControls) {
    const before = await host.script(
      "window.__keyControl.clear();return window.__keyControl.snapshot();",
    );
    if (!record(before) || typeof before.value !== "string" || typeof before.start !== "number")
      throw new Error("Missing original sequence state");
    await host.press(item.key);
    const after = await host.script("return window.__keyControl.snapshot();");
    checkKeyEdges(after, item.key, "primary", false);
    checkKeyEffect(after, item.key, before.value, before.start, false);
    rejectKeyMutations(after, item.key);
    sequence.push({ key: item.key, before, after });
  }
  return sequence;
}
function rejectKeyMutations(snapshot: unknown, key: import("./protocol.js").HostKey): void {
  if (!record(snapshot) || !Array.isArray(snapshot.events))
    throw new Error("Missing observed edges");
  const down: unknown = snapshot.events[0];
  const up: unknown = snapshot.events[1];
  if (!record(down) || !record(up)) throw new Error("Missing real key edges");
  const mutations = [
    { ...snapshot, events: [] },
    { ...snapshot, events: [down] },
    { ...snapshot, events: [{ ...down, key: "wrong" }, up] },
    { ...snapshot, events: [{ ...down, code: "NumpadEnter", location: 3 }, up] },
    {
      ...snapshot,
      events: [
        { ...down, trusted: false },
        { ...up, trusted: false },
      ],
    },
  ];
  for (const mutation of mutations) requireKeyRejection(mutation, key);
}
function requireKeyRejection(value: unknown, key: import("./protocol.js").HostKey): void {
  try {
    checkKeyEdges(value, key, "primary", false);
  } catch {
    return;
  }
  throw new Error("Key observer accepted dropped, unreleased, keypad, wrong, or synthetic input");
}
