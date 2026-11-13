import { expect, test } from "bun:test";
import { controlLoad } from "../proc/control.js";
import {
  captureTerminalLifetime,
  enterTerminalSection,
  leaveTerminalSection,
} from "../proc/terminal-lifetime.js";
import { createWorkerProcessTransport, workerProcessState } from "../proc/worker-client.js";

function fixture() {
  const process = createWorkerProcessTransport({ capacity: 4 });
  const state = workerProcessState(process);
  return { process, state, lifetime: captureTerminalLifetime(process) };
}

test("handoff rearms without publishing terminal stop and joins each image's sections", async () => {
  const { process, state, lifetime } = fixture();
  expect(await lifetime.handoff(() => true)).toBe(true);
  expect(controlLoad(state.terminalStopped)).toBe(0);
  expect(enterTerminalSection(state)).toBe(true);
  let joined = false;
  const next = lifetime.handoff(() => true).then((value) => {
    joined = true;
    return value;
  });
  await Promise.resolve();
  expect(joined).toBe(false);
  expect(enterTerminalSection(state)).toBe(false);
  leaveTerminalSection(state, process.directory);
  expect(await next).toBe(true);
  expect(enterTerminalSection(state)).toBe(true);
  const final = lifetime.quiesce();
  expect(controlLoad(state.terminalAdmission)).toBe(-2);
  leaveTerminalSection(state, process.directory);
  await final;
  lifetime.stopped();
  expect(controlLoad(state.terminalStopped)).toBe(1);
});

test("permanent final revocation dominates a pending handoff and later handoffs", async () => {
  const { process, state, lifetime } = fixture();
  expect(enterTerminalSection(state)).toBe(true);
  const handoff = lifetime.handoff(() => true);
  const final = lifetime.quiesce();
  leaveTerminalSection(state, process.directory);
  expect(await handoff).toBe(false);
  await final;
  expect(await lifetime.handoff(() => true)).toBe(false);
  expect(enterTerminalSection(state)).toBe(false);
  expect(controlLoad(state.terminalStopped)).toBe(0);
  lifetime.stopped();
});

test("cancelled replacement leaves terminal admission closed", async () => {
  const { process, state, lifetime } = fixture();
  expect(enterTerminalSection(state)).toBe(true);
  let active = true;
  const handoff = lifetime.handoff(() => active);
  active = false;
  leaveTerminalSection(state, process.directory);
  expect(await handoff).toBe(false);
  expect(enterTerminalSection(state)).toBe(false);
  await lifetime.quiesce();
  lifetime.stopped();
});
