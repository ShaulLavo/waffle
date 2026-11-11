import { record, type HostKey } from "./protocol.js";
import type { KeySnapshot } from "./key-press-fixture.js";

export type KeyEffect = Pick<KeySnapshot, "value" | "start" | "end">;

export const keyControlId = "key-press: current focus and trusted edges";
export const keyControls: readonly { key: HostKey; value: string; position: number }[] = [
  { key: "Home", value: "first\nsecond\nthird", position: 17 },
  { key: "ArrowUp", value: "first\nsecond\nthird", position: 15 },
  { key: "ArrowRight", value: "first\nsecond\nthird", position: 7 },
  { key: "Enter", value: "first\nsecond\nthird", position: 8 },
];
export function checkKeyEdges(
  value: unknown,
  key: HostKey,
  target: string,
  prevent: boolean,
): void {
  if (!record(value) || !Array.isArray(value.events) || value.events.length !== 2)
    throw new Error("Missing complete key-down/up pair");
  for (let index = 0; index < value.events.length; index++)
    checkEdge(value.events[index], key, target, index === 0 ? "keydown" : "keyup", prevent);
  if (
    value.focused !== target ||
    value.decoy !== `untouched-${target === "primary" ? "decoy" : "primary"}`
  )
    throw new Error("Key refocused a target or changed the decoy");
}
function checkEdge(
  value: unknown,
  key: HostKey,
  target: string,
  type: string,
  prevent: boolean,
): void {
  if (
    !record(value) ||
    value.type !== type ||
    value.target !== target ||
    value.key !== key ||
    value.code !== key ||
    value.location !== 0 ||
    value.repeat !== false ||
    value.trusted !== true ||
    value.alt !== false ||
    value.ctrl !== false ||
    value.meta !== false ||
    value.shift !== false ||
    value.prevented !== (prevent && type === "keydown") ||
    typeof value.value !== "string" ||
    !Number.isSafeInteger(value.start) ||
    !Number.isSafeInteger(value.end)
  )
    throw new Error(`Wrong trusted ${type} identity: ${JSON.stringify(value)}`);
}
export function checkKeyEffect(
  value: unknown,
  key: HostKey,
  text: string,
  position: number,
  prevent: boolean,
): void {
  if (!record(value)) throw new Error("Missing key state");
  if (prevent) {
    if (value.value !== text || value.start !== position || value.end !== position)
      throw new Error("preventDefault did not preserve editable state");
    return;
  }
  const expected = key === "Enter" ? text.slice(0, position) + "\n" + text.slice(position) : text;
  if (value.value !== expected) throw new Error("Native key inserted wrong text");
  if (value.start !== value.end || typeof value.start !== "number")
    throw new Error("Wrong caret state");
  if (key === "ArrowRight" && value.start !== position + 1)
    throw new Error("ArrowRight did not move caret");
  if (key === "ArrowUp" && value.start >= position)
    throw new Error("ArrowUp did not move to previous line");
  if (key === "Enter" && value.start !== position + 1)
    throw new Error("Enter did not insert a newline");
  // Home is platform-specific. Local controls additionally compare the original Page action.
}
export function checkKeyControlResult(value: unknown): void {
  if (
    !record(value) ||
    !record(value.body) ||
    value.body.status !== "pass" ||
    !record(value.body.result) ||
    !Array.isArray(value.body.result.observations) ||
    value.body.result.observations.length !== 12 ||
    !Array.isArray(value.body.result.sequence) ||
    value.body.result.sequence.length !== 4 ||
    !record(value.teardown) ||
    value.teardown.status !== "pass" ||
    !record(value.teardown.result) ||
    value.teardown.result.disposed !== true ||
    value.teardown.result.textareas !== 0
  )
    throw new Error("Incomplete key control or teardown");
  for (let index = 0; index < 12; index++) {
    const item = keyControls[index % 4];
    if (!item) throw new Error("Missing key control");
    const observation: unknown = value.body.result.observations[index];
    checkKeyEdges(observation, item.key, index >= 8 ? "decoy" : "primary", index >= 4 && index < 8);
    checkKeyEffect(observation, item.key, item.value, item.position, index >= 4 && index < 8);
  }
  for (let index = 0; index < 4; index++) {
    const item = keyControls[index];
    const step: unknown = value.body.result.sequence[index];
    if (
      !item ||
      !record(step) ||
      step.key !== item.key ||
      !record(step.before) ||
      typeof step.before.value !== "string" ||
      typeof step.before.start !== "number"
    )
      throw new Error("Incomplete continuous key sequence");
    checkKeyEdges(step.after, item.key, "primary", false);
    checkKeyEffect(step.after, item.key, step.before.value, step.before.start, false);
  }
}
export function sameKeyEffect(actual: unknown, original: KeyEffect): void {
  if (
    !record(actual) ||
    actual.value !== original.value ||
    actual.start !== original.start ||
    actual.end !== original.end
  )
    throw new Error("Guarded key default differs from the original Page keyboard action");
}
