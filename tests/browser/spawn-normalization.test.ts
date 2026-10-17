import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../../crates/bunwasm-runtime/src/js/spawn.js", import.meta.url), "utf8");

for (const executable of ["node", "/usr/bin/node", "fixture.wasm", "/tools/custom"]) {
  test(`guest command normalization preserves registry executable ${executable}`, () => {
    let metadata: { executable: string; argv: string[] } | undefined;
    const factory = runInNewContext(source, {
      process: { execPath: "/bun", argv0: "bun", env: {} }, URL,
    });
    const api = factory({
      require,
      native: {
        cwd: () => "/",
        hostCaps: { spawn: true },
        hostSpawn(text: string) { metadata = JSON.parse(text); return -1; },
        hostError: () => '{"message":"deliberate test stop","code":"EIO"}',
      },
    });
    expect(() => api.spawn([executable, "argument"])).toThrow("deliberate test stop");
    expect(metadata).toEqual({
      executable, argv: [executable, "argument"], cwd: "/", env: {},
      stdin: "ignore", stdout: "pipe", stderr: "inherit",
    });
  });
}

for (const ownCode of [23, 143]) test(`a handled TERM preserves guest own code ${ownCode} in the Bun facade`, async () => {
  let status = -2;
  let waiter: { step(): unknown } | undefined;
  const factory = runInNewContext(source, {
    process: { execPath: "/usr/local/bin/bun", argv0: "bun", env: {} }, URL,
  });
  const api = factory({
    require,
    addIoWaiter(value: { step(): unknown }) { waiter = value; return value; },
    native: {
      cwd: () => "/", hostCaps: { spawn: true }, hostSpawn: () => 2,
      hostChildWait: () => status, hostChildKill: () => 0, hostClose: () => 0,
      hostChildPipe(_pid: number, selector: number) { expect(selector).toBe(3); return 0; },
    },
  });
  const child = api.spawn(["fixture"], { stdio: ["ignore", "ignore", "ignore"] });
  child.kill("SIGTERM");
  status = ownCode;
  waiter!.step();
  expect(await child.exited).toBe(ownCode);
  expect(child.exitCode).toBe(ownCode);
  expect(child.signalCode).toBeNull();
  expect(child.killed).toBe(true);
});

for (const signal of ["SIGTERM", "SIGKILL"]) test(`spawnSync timeout ${signal} preserves request versus forced status`, () => {
  let status = -2;
  let now = 0;
  const requested: number[] = [];
  const factory = runInNewContext(source, { process: { env: {} }, URL });
  const api = factory({
    require, concatBytes: () => new Uint8Array(),
    native: {
      cwd: () => "/", hostCaps: { spawn: true }, hostSpawn: () => 2,
      now: () => now++, hostChildWait: () => status, hostPoll() {}, hostClose: () => 0,
      hostChildPipe(_pid: number, selector: number) { expect(selector).toBe(3); return signal === "SIGKILL" ? 9 : 0; },
      hostChildKill(_pid: number, number: number) { requested.push(number); status = number === 9 ? 137 : 23; return 0; },
    },
  });
  const result = api.spawnSync(["fixture"], { stdio: ["ignore", "ignore", "ignore"], timeout: 1, killSignal: signal });
  expect(result.exitedDueToTimeout).toBe(true);
  expect(result.exitCode).toBe(signal === "SIGKILL" ? null : 23);
  expect(result.signalCode).toBe(signal === "SIGKILL" ? "SIGKILL" : null);
  expect(requested).toEqual([signal === "SIGKILL" ? 9 : 15]);
});

for (const [status, signal, name] of [[143, 15, "SIGTERM"], [141, 13, "SIGPIPE"], [137, 9, "SIGKILL"], [143, 0, null]] as const) {
  test(`async facade reads final kind ${name ?? "own exit"} for status ${status}`, async () => {
    let done = false;
    let waiter: { step(): unknown } | undefined;
    const api = runInNewContext(source, { process: { env: {} }, URL })({
      require, addIoWaiter(value: { step(): unknown }) { waiter = value; return value; },
      native: {
        cwd: () => "/", hostCaps: { spawn: true }, hostSpawn: () => 2,
        hostChildWait: () => done ? status : -2, hostChildKill: () => 0, hostClose: () => 0,
        hostChildPipe(_pid: number, selector: number) { expect(selector).toBe(3); return signal; },
      },
    });
    const child = api.spawn(["fixture"], { stdio: ["ignore", "ignore", "ignore"] });
    done = true;
    waiter!.step();
    expect(await child.exited).toBe(status);
    expect(child.signalCode).toBe(name);
    expect(child.exitCode).toBe(signal ? null : status);
  });
}

for (const ownCode of [23, 137, 143]) for (const acceptance of [0, -3]) {
  test(`async late KILL (${acceptance}) retains selected own exit ${ownCode}`, async () => {
    let status = -2;
    let waiter: { step(): unknown } | undefined;
    const api = runInNewContext(source, { process: { env: {} }, URL })({
      require, addIoWaiter(value: { step(): unknown }) { waiter = value; return value; },
      native: {
        cwd: () => "/", hostCaps: { spawn: true }, hostSpawn: () => 2, hostClose: () => 0,
        hostChildWait: () => status,
        hostChildKill() { status = ownCode; return acceptance; },
        hostChildPipe(_pid: number, selector: number) { expect(selector).toBe(3); return 0; },
      },
    });
    const child = api.spawn(["fixture"], { stdio: ["ignore", "ignore", "ignore"] });
    child.kill("SIGKILL");
    waiter!.step();
    expect(await child.exited).toBe(ownCode);
    expect(child.exitCode).toBe(ownCode);
    expect(child.signalCode).toBeNull();
  });
}

for (const [status, signal, name] of [[143, 15, "SIGTERM"], [143, 0, null], [137, 9, "SIGKILL"]] as const) {
  test(`sync facade reads actual selected ${name ?? "own exit"} after a TERM timeout request`, () => {
    let completed = false;
    let now = 0;
    const api = runInNewContext(source, { process: { env: {} }, URL })({
      require, concatBytes: () => new Uint8Array(),
      native: {
        cwd: () => "/", hostCaps: { spawn: true }, hostSpawn: () => 2, hostClose: () => 0,
        now: () => now++, hostPoll() {}, hostChildWait: () => completed ? status : -2,
        hostChildKill(_pid: number, number: number) { expect(number).toBe(15); completed = true; return 0; },
        hostChildPipe(_pid: number, selector: number) { expect(selector).toBe(3); return signal; },
      },
    });
    const result = api.spawnSync(["fixture"], { stdio: ["ignore", "ignore", "ignore"], timeout: 1 });
    expect(result.exitedDueToTimeout).toBe(true);
    expect(result.signalCode).toBe(name);
    expect(result.exitCode).toBe(signal ? null : status);
  });
}

test("sync timeout KILL losing to ordinary exit143 does not relabel it", () => {
  let completed = false;
  let now = 0;
  const api = runInNewContext(source, { process: { env: {} }, URL })({
    require, concatBytes: () => new Uint8Array(),
    native: {
      cwd: () => "/", hostCaps: { spawn: true }, hostSpawn: () => 2, hostClose: () => 0,
      now: () => now++, hostPoll() {}, hostChildWait: () => completed ? 143 : -2,
      hostChildKill() { completed = true; return -3; },
      hostChildPipe(_pid: number, selector: number) { expect(selector).toBe(3); return 0; },
    },
  });
  const result = api.spawnSync(["fixture"], { stdio: ["ignore", "ignore", "ignore"], timeout: 1, killSignal: "SIGKILL" });
  expect(result.error).toBeUndefined();
  expect(result.exitedDueToTimeout).toBe(true);
  expect(result.exitCode).toBe(143);
  expect(result.signalCode).toBeNull();
});

test("async KILL is a no-op while selected own143 awaits publication", async () => {
  let published = false;
  let waiter: { step(): unknown } | undefined;
  let queries = 0;
  const api = runInNewContext(source, { process: { env: {} }, URL })({
    require, addIoWaiter(value: { step(): unknown }) { waiter = value; return value; },
    native: {
      cwd: () => "/", hostCaps: { spawn: true }, hostSpawn: () => 2, hostClose: () => 0,
      hostChildWait: () => published ? 143 : -2,
      hostChildKill: () => 0,
      hostChildPipe() { queries++; return 0; },
    },
  });
  const child = api.spawn(["fixture"], { stdio: ["ignore", "ignore", "ignore"] });
  child.kill("SIGKILL");
  for (let i = 0; i < 3; i++) waiter!.step();
  expect(queries).toBe(0);
  expect(child.exitCode).toBeNull();
  published = true;
  waiter!.step();
  expect(await child.exited).toBe(143);
  expect(child.exitCode).toBe(143);
  expect(child.signalCode).toBeNull();
  expect(queries).toBe(1);
});

test("sync timeout request is a no-op while own143 awaits publication", () => {
  let polls = 0;
  let requests = 0;
  let now = 0;
  const api = runInNewContext(source, { process: { env: {} }, URL })({
    require, concatBytes: () => new Uint8Array(),
    native: {
      cwd: () => "/", hostCaps: { spawn: true }, hostSpawn: () => 2, hostClose: () => 0,
      now: () => now++, hostPoll() { polls++; }, hostChildWait: () => polls >= 5 ? 143 : -2,
      hostChildKill() { requests++; return 0; },
      hostChildPipe() { expect(polls).toBeGreaterThanOrEqual(5); return 0; },
    },
  });
  const result = api.spawnSync(["fixture"], { stdio: ["ignore", "ignore", "ignore"], timeout: 1, killSignal: "SIGKILL" });
  expect(result.error).toBeUndefined();
  expect(result.exitedDueToTimeout).toBe(true);
  expect(result.exitCode).toBe(143);
  expect(result.signalCode).toBeNull();
  expect(requests).toBe(1);
});

for (const [status, signal, name] of [[137, 9, "SIGKILL"], [137, 0, null], [143, 0, null], [23, 0, null], [0, 0, null]] as const) {
  test(`spawnSync maxBuffer error observes delayed selected ${name ?? `exit ${status}`} before close`, () => {
    let polls = 0;
    let metadataQueries = 0;
    let earlyClose = false;
    const requests: number[] = [];
    const closed: number[] = [];
    const api = runInNewContext(source, { process: { env: {} }, URL })({
      require, concatBytes: () => new Uint8Array(),
      native: {
        cwd: () => "/", hostCaps: { spawn: true }, hostSpawn: () => 2, now: () => 0,
        hostRead: () => new Uint8Array([1, 2]),
        hostChildPipe(_pid: number, selector: number) {
          if (selector === 1) return 11;
          expect(selector).toBe(3);
          expect(polls).toBe(3);
          metadataQueries++;
          return signal;
        },
        hostChildKill(_pid: number, requested: number) { requests.push(requested); return 0; },
        hostChildWait: () => polls < 3 ? -2 : status,
        hostPoll() { expect(++polls).toBeLessThanOrEqual(3); },
        hostClose(handle: number) { earlyClose ||= polls < 3; closed.push(handle); },
      },
    });
    const result = api.spawnSync(["fixture"], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 });
    expect(result.error.code).toBe("ENOBUFS");
    expect(result.success).toBe(false);
    expect(result.signalCode).toBe(name);
    expect(result.exitCode).toBe(signal ? null : status);
    expect(requests).toEqual([9]);
    expect(metadataQueries).toBe(1);
    expect(earlyClose).toBe(false);
    expect(closed).toEqual([11, 2]);
  });
}
