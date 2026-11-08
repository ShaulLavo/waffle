import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ownershipPeerInput } from "./fixtures/gpu/peer-input.js";

test("peer input waits until another frame checkpoint", () => {
  expect(ownershipPeerInput(0, 0)).toBe("wait");
  expect(ownershipPeerInput(12, 12)).toBe("wait");
});
test("peer input feeds below the unchanged frame cap", () => {
  expect(ownershipPeerInput(1, 0)).toBe("feed");
  expect(ownershipPeerInput(239, 238)).toBe("feed");
});
test("reaching exactly 240 frames exhausts rather than exceeds the workload", () => {
  expect(ownershipPeerInput(240, 239)).toBe("exhausted");
});
test("passing 240 frames still reports a workload error", () => {
  expect(ownershipPeerInput(241, 239)).toBe("exceeded");
});

function peerPump(interval?: number, initialFrames = 1) {
  const source = readFileSync(
    new URL("./fixtures/gpu/integration-page.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export function ownershipPeer(");
  const end = source.indexOf("\n/** @browserEntry */", start + 1);
  if (start < 0 || end < 0) throw new Error("Missing actual peer pump entry");
  const body = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(
    source.slice(start, end).replace("export function", "function"),
  );
  const errors: string[] = [];
  const clock = {
    frames: initialFrames,
    errors,
    period: 0,
    active: false,
    tick: () => {},
    now: 0,
  };
  const run: unknown = new Function(
    "clock",
    "ownershipPeerInput",
    `
let peerPump;
const errors = clock.errors;
const clearInterval = () => { clock.active = false; };
const setInterval = (tick, period) => { clock.tick = tick; clock.period = period; clock.active = true; return 1; };
const drainTriangle = () => ({ text: "GPU_WAIT_STDIN stage=fairness-peer frame=1\\n".repeat(clock.frames) });
const feedTriangle = () => { clock.frames++; return 1; };
${body}
return ownershipPeer;
`,
  )(clock, ownershipPeerInput);
  if (typeof run !== "function") throw new Error("Missing actual peer pump function");
  run(true, interval);
  return {
    clock,
    advance(milliseconds: number) {
      const end = clock.now + milliseconds;
      while (clock.active && clock.now + clock.period <= end) {
        clock.now += clock.period;
        clock.tick();
      }
      clock.now = end;
    },
  };
}

test("quota peer input remains available through the captured eight-second lifecycle", () => {
  const source = readFileSync(new URL("./gpu-grant-quota-browser.ts", import.meta.url), "utf8");
  const selected = source.match(/"ownershipPeer",\s*\[true(?:,\s*(\d+))?\]/);
  expect(selected).not.toBeNull();
  const pump = peerPump(Number(selected?.[1] ?? 20));
  expect(pump.clock.period).toBe(40);
  pump.advance(8500);
  expect(pump.clock.frames).toBeLessThan(240);
  const before = pump.clock.frames;
  pump.advance(pump.clock.period);
  expect(pump.clock.frames).toBeGreaterThan(before);
  expect(pump.clock.errors).toEqual([]);
});

test("other peer cases keep the original cadence and exact frame cap", () => {
  const pump = peerPump();
  expect(pump.clock.period).toBe(20);
  pump.advance(10000);
  expect(pump.clock.frames).toBe(240);
  expect(pump.clock.active).toBe(false);
  expect(pump.clock.errors).toEqual([]);
});

test("the quota cadence does not accept actual frame excess", () => {
  const pump = peerPump(40, 241);
  pump.advance(40);
  expect(pump.clock.frames).toBe(241);
  expect(pump.clock.active).toBe(false);
  expect(pump.clock.errors).toEqual(["Ownership peer exceeded its bounded continuous workload"]);
});
