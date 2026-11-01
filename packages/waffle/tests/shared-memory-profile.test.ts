import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as memory from "../memory/index.js";
import { SharedMemoryLedger } from "../memory/reservations.js";

const webkit = "AppleWebKit/605.1.15";
const mobile = [
  "iPhone Safari/605",
  "iPad Safari/605",
  "iPod Safari/605",
  "iPhone CriOS/142",
  "iPhone FxiOS/145",
  "iPhone EdgiOS/142",
  "iPhone Mobile/15E148",
];
for (const userAgent of mobile)
  test(`P1 mobile WebKit ${userAgent}`, () => {
    expect(
      memory.sharedMemoryProfile({ userAgent: `${userAgent} ${webkit}`, maxTouchPoints: 5 }),
    ).toMatchObject({ profile: "apple-mobile-webkit", match: "ios-user-agent" });
  });
for (const userAgent of [
  "Macintosh Safari",
  "Macintosh Chrome",
  "Windows Chrome",
  "X11 Linux Chrome",
  "X11 Linux Firefox",
  "Android Chrome",
  "Bun/1.4.4",
  "",
  "iPhone without engine",
])
  test(`P1 desktop default ${userAgent}`, () => {
    expect(
      memory.sharedMemoryProfile({
        userAgent: userAgent === "iPhone without engine" ? userAgent : `${userAgent} ${webkit}`,
        maxTouchPoints: 0,
      }),
    ).toEqual({ kind: "unbounded", source: "profile", profile: "desktop" });
  });
test("P1 iPadOS desktop user agent requires touch points", () => {
  expect(
    memory.sharedMemoryProfile({ userAgent: `Macintosh ${webkit}`, maxTouchPoints: 5 }),
  ).toMatchObject({ profile: "apple-mobile-webkit", match: "ipados-desktop-user-agent" });
  expect(
    memory.sharedMemoryProfile({ userAgent: `Macintosh ${webkit}`, maxTouchPoints: 0 }),
  ).toMatchObject({ profile: "desktop" });
});
test("P2 profile policy is frozen and has explicit assumed provenance", () => {
  const platform = memory.sharedMemoryProfile({ userAgent: `iPhone ${webkit}`, maxTouchPoints: 5 });
  expect(platform).toEqual({
    kind: "bounded",
    source: "profile",
    profile: "apple-mobile-webkit",
    match: "ios-user-agent",
    assumedPoolBytes: memory.bytes(4 * 1024 ** 3),
    marginBytes: memory.bytes(1024 ** 3),
    budgetBytes: memory.bytes(3 * 1024 ** 3),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: false },
  });
  expect(Object.isFrozen(platform)).toBe(true);
  if (platform.kind !== "bounded") throw new Error("expected bounded profile");
  expect(Object.isFrozen(platform.counts)).toBe(true);
});
test("P4 application factory copies only allowlisted fields and freezes nested policy", () => {
  const counts = { fixedBuffer: true, sharedMemory: true, privateMemory: false };
  const platform = memory.declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: memory.bytes(1024 ** 3),
    counts,
  });
  counts.privateMemory = true;
  expect(platform.source).toBe("application");
  if (platform.kind !== "bounded") throw new Error("expected bounded override");
  expect(platform.counts.privateMemory).toBe(false);
  expect(Object.isFrozen(platform)).toBe(true);
  expect(Object.isFrozen(platform.counts)).toBe(true);
  expect(Reflect.set(platform.counts, "privateMemory", true)).toBe(false);
  const snapshot = new SharedMemoryLedger(platform).openRuntime(platform).snapshot();
  expect(Reflect.set(snapshot.platform, "budgetBytes", 1)).toBe(false);
  expect(
    Reflect.apply(memory.declareSharedMemoryPlatform, undefined, [
      { kind: "unbounded", source: "profile", profile: "apple-mobile-webkit", counts: {} },
    ]),
  ).toEqual({ kind: "unbounded", source: "application" });
});
for (const input of [
  null,
  {},
  { kind: "unknown" },
  { kind: "bounded", budgetBytes: 0, counts: {} },
  { kind: "bounded", budgetBytes: 1.5, counts: {} },
  { kind: "bounded", budgetBytes: -1, counts: {} },
  { kind: "bounded", budgetBytes: 1 },
  { kind: "bounded", budgetBytes: 1, counts: { fixedBuffer: true, sharedMemory: true } },
])
  test(`P4 factory deliberately rejects ${JSON.stringify(input)}`, () => {
    expect(() => Reflect.apply(memory.declareSharedMemoryPlatform, undefined, [input])).toThrow(
      TypeError,
    );
  });
test("P4 copied application objects cannot cross the issuance boundary", () => {
  const issued = memory.declareSharedMemoryPlatform({ kind: "unbounded" });
  expect(() => new SharedMemoryLedger(issued).openRuntime({ ...issued })).toThrow(TypeError);
  expect(() =>
    new SharedMemoryLedger(issued).openRuntime(JSON.parse(JSON.stringify(issued))),
  ).toThrow(TypeError);
});

function fresh(mode: string, entry = new URL("../index.ts", import.meta.url).href): void {
  const result = spawnSync(
    process.execPath,
    [new URL("./fixtures/shared-memory-profile-control.ts", import.meta.url).pathname, mode, entry],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
}
for (const mode of [
  "import",
  "select",
  "absent",
  "desktop",
  "mobile",
  "override",
  "override-bounded",
  "forged",
  "failed",
  "ownership",
])
  test(`P2 P3 P4 fresh source realm ${mode}`, () => fresh(mode));

for (const counts of [
  { fixedBuffer: true, sharedMemory: true, privateMemory: false },
  { fixedBuffer: true, sharedMemory: true, privateMemory: true },
])
  test(`P6 full private and mixed declaration metadata stays separate from counted charges ${counts.privateMemory}`, () => {
    const platform = memory.declareSharedMemoryPlatform({
      kind: "bounded",
      budgetBytes: memory.bytes(3 * 1024 ** 3),
      counts,
    });
    const runtime = new SharedMemoryLedger(platform).openRuntime(platform);
    const declarations = [
      { kind: "private", origin: "defined", maximumPages: memory.pages(8192) },
      { kind: "private", origin: "imported", maximumPages: memory.pages(4096) },
      {
        kind: "shared",
        origin: "imported",
        initialPages: memory.pages(1),
        maximumPages: memory.pages(2),
      },
    ] as const;
    const launched = runtime
      .admit({
        pid: 1,
        executable: "fixture",
        guest: { kind: "declared", memories: declarations },
        group: "none",
        connection: false,
        controls: false,
      })
      .launched();
    const holder = runtime.snapshot().holders.find((h) => h.label === "guest-memory");
    expect(holder?.declaredBytes).toBe((8192 + 4096 + 2) * 65536);
    expect(runtime.snapshot().reservedBytes).toBe(
      (counts.privateMemory ? 8192 + 4096 + 2 : 2) * 65536,
    );
    launched.stopped();
    expect(runtime.snapshot().holders).toHaveLength(0);
  });
test("P6 built-in profile and equivalent override record each frozen private maximum without charging it", () => {
  const profiles = [
    memory.sharedMemoryProfile({ userAgent: `iPhone ${webkit}`, maxTouchPoints: 5 }),
    memory.declareSharedMemoryPlatform({
      kind: "bounded",
      budgetBytes: memory.bytes(3 * 1024 ** 3),
      counts: { fixedBuffer: true, sharedMemory: true, privateMemory: false },
    }),
  ];
  for (const platform of profiles) {
    const runtime = new SharedMemoryLedger(platform).openRuntime(platform);
    for (const maximum of [8192, 4096]) {
      const ticket = runtime.admit({
        pid: maximum,
        executable: "frozen guest",
        guest: {
          kind: "declared",
          memories: [{ kind: "private", origin: "defined", maximumPages: memory.pages(maximum) }],
        },
        group: "none",
        connection: false,
        controls: false,
      });
      expect(
        runtime.snapshot().holders.find((h) => h.label === "guest-memory")?.declaredBytes,
      ).toBe(maximum * 65536);
      expect(runtime.snapshot().reservedBytes).toBe(0);
      ticket.launched().stopped();
      expect(runtime.snapshot().holders).toHaveLength(0);
    }
  }
});
test("P5 measurement API and package entries are removed", async () => {
  const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
  expect(manifest.exports).not.toHaveProperty("./memory/probe-worker");
  expect(manifest.exports).not.toHaveProperty("./memory");
  for (const key of ["measureSharedMemory", "SharedMemoryMeasurementError"])
    expect(memory).not.toHaveProperty(key);
  const source = await Bun.file(new URL("../memory/reservations.ts", import.meta.url)).text();
  expect(source).not.toMatch(
    /PROBE_|probedBytes|SharedMemoryMeasureOptions|SharedMemoryObservation|ProbeResult/,
  );
});

for (const command of [process.execPath, "node"])
  test(`P2 ${command} prepared root import and explicit selector are environment and backing inert`, () => {
    const entry = new URL("../dist/index.js", import.meta.url).href;
    const script = `
      import assert from "node:assert/strict";
      let allocations=0;
      Object.defineProperty(globalThis,"navigator",{configurable:true,get(){throw Error("import read navigator")}});
      for(const key of ["SharedArrayBuffer","Worker"]){const ctor=globalThis[key]??function(){};globalThis[key]=new Proxy(ctor,{construct(){allocations++;throw Error("import allocation")}})}
      WebAssembly.Memory=new Proxy(WebAssembly.Memory,{construct(){allocations++;throw Error("import memory")}});
      const api=await import(${JSON.stringify(entry)});
      assert.equal(api.sharedMemoryProfile({userAgent:"",maxTouchPoints:0}).profile,"desktop");
      assert.equal(allocations,0);
    `;
    const result = spawnSync(command, ["--input-type=module", "--eval", script], {
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

for (const budgetBytes of [0, 1.5, -1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "3221225472"])
  test(`P4 invalid budget with complete counted kinds is a deliberate TypeError: ${budgetBytes}`, () => {
    expect(() =>
      Reflect.apply(memory.declareSharedMemoryPlatform, undefined, [
        {
          kind: "bounded",
          budgetBytes,
          counts: { fixedBuffer: true, sharedMemory: true, privateMemory: false },
        },
      ]),
    ).toThrow(TypeError);
  });
