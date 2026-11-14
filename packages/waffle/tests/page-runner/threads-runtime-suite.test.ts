import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runPageSuite } from "waffle/testing/page-runner";
import { parseRuntimeThreadCommand } from "../threads-runtime-browser-runner.js";
import {
  runtimeThreadCases,
  stockThreadCase,
  isRuntimeThreadCase,
} from "../threads-runtime-cases.js";
import {
  threadsRuntimeAdapter,
  threadRuntimeId,
  checkThreadRuntimeResult,
} from "./threads-runtime-suite.js";
import { FakeDriver } from "./fake-driver.js";
import { record } from "./protocol.js";

const fixtureSha256 = "verified-fixture";
const ids = runtimeThreadCases.map(threadRuntimeId);
function resultFor(
  selected: (typeof runtimeThreadCases)[number],
  url = `https://fixture.invalid/${selected}`,
) {
  const killed = ["kill-start", "cpu", "wait32", "wait64"].includes(selected);
  const stock = stockThreadCase(selected);
  return {
    selected,
    fixtureSha256,
    isolated: true,
    document: { url, timeOrigin: runtimeThreadCases.indexOf(selected) + 1 },
    exit: killed ? { kind: "signaled", code: 9 } : { kind: "exited", code: 0 },
    siblingExit: { kind: "exited", code: 0 },
    workers: 6,
    stopped: 6,
    fenceBlocked: killed,
    output: stock
      ? `threads-ok mode=${selected} main-static=1369948382 main-tls=901\n`
      : selected === "join"
        ? "c"
        : "",
    backingObservation: { samples: 3, peakAliases: 3 },
    sharedGuests: [
      {
        initialPages: stock ? 17 : 2,
        sourceMaximumPages: stock ? 16384 : 512,
        actualMaximumPages: 512,
        chargedBytes: 33554432,
        phase: "awaiting-collection",
        fence: "passed",
        aliases: { reserved: 0, transferred: 0, retained: 0 },
        continuations: { active: 0, retained: 0 },
      },
    ],
    controlDebts: [80, 4],
    debtBytes: 84,
  };
}
function adapter() {
  return threadsRuntimeAdapter("", { fixtureSha256, assets: {} });
}

test("browser CLI defaults to all nine, preserves focused selectors and dispatches native first", () => {
  expect(parseRuntimeThreadCommand([])).toEqual({
    kind: "browser",
    engines: ["chromium"],
    cases: runtimeThreadCases,
  });
  expect(parseRuntimeThreadCommand(["chromium", "firefox", "webkit"])).toEqual({
    kind: "browser",
    engines: ["chromium", "firefox", "webkit"],
    cases: runtimeThreadCases,
  });
  for (const selected of runtimeThreadCases)
    expect(parseRuntimeThreadCommand(["--case", selected, "webkit"])).toEqual({
      kind: "browser",
      engines: ["webkit"],
      cases: [selected],
    });
  expect(parseRuntimeThreadCommand(["ios-safari", "--result", "/result.json"])).toEqual({
    kind: "native",
    args: ["--result", "/result.json"],
  });
  for (const args of [
    ["--case"],
    ["--case", "unknown"],
    ["chromium", "--result", "/result.json"],
    ["safari"],
    ["--case", "pair", "--case", "repeat"],
  ])
    expect(() => parseRuntimeThreadCommand(args)).toThrow();
});

test("native inventory requests literal case names, complete ordered inventory and original budgets", () => {
  const suite = adapter();
  expect(suite.inventory().map((item) => item.id)).toEqual(ids);
  expect(suite.inventory().map((item) => item.request("run"))).toEqual(
    runtimeThreadCases.map((selected) => ({ selected, fixtureSha256 })),
  );
  expect(suite.policy.listIds({ ids })).toEqual(ids);
  for (const wrong of [[], ids.slice(1), ids.concat(ids[0]!), ids.toReversed()])
    expect(() => suite.policy.listIds({ ids: wrong })).toThrow("inventory");
  expect(suite.budgets(9)).toEqual({
    hello: 20000,
    heartbeat: 10000,
    case: 120000,
    group: 120000,
    run: 600000,
  });
});

test("native result checks reject wrong producer, memory, retirement, outcome and control debt", () => {
  const complete = resultFor("pair");
  checkThreadRuntimeResult("pair", fixtureSha256, complete);
  for (const patch of [
    { fixtureSha256: "other" },
    { output: "wrong" },
    { isolated: false },
    { stopped: 1 },
    { sharedGuests: [] },
    { debtBytes: 0 },
    { controlDebts: ["84"] },
    { backingObservation: { peakAliases: 2 } },
    { selected: "join" },
  ])
    expect(() =>
      checkThreadRuntimeResult("pair", fixtureSha256, { ...complete, ...patch }),
    ).toThrow();
  for (const patch of [
    { initialPages: 2 },
    { sourceMaximumPages: 512 },
    { actualMaximumPages: 16384 },
    { chargedBytes: 67108864 },
    { phase: "debt" },
    { fence: "pending" },
    { aliases: { reserved: 1, transferred: 0, retained: 0 } },
    { continuations: { active: 0, retained: 1 } },
  ])
    expect(() =>
      checkThreadRuntimeResult("pair", fixtureSha256, {
        ...complete,
        sharedGuests: [{ ...complete.sharedGuests[0], ...patch }],
      }),
    ).toThrow();
  expect(() =>
    checkThreadRuntimeResult("cpu", fixtureSha256, { ...resultFor("cpu"), fenceBlocked: false }),
  ).toThrow();
  const suite = adapter();
  suite.policy.check(ids[0]!, complete);
  expect(() => suite.policy.check(ids[0]!, complete)).toThrow("document reused");
});

class ThreadFakeDriver extends FakeDriver {
  protected override async run(role: unknown, request: unknown): Promise<void> {
    if (role === "case" && record(request) && isRuntimeThreadCase(request.selected) && this.command)
      this.command.result = resultFor(request.selected, this.currentURL);
    await super.run(role, request);
  }
}
for (const mode of ["pass", "assertion", "driver-lost", "cleanup-fails"] as const) {
  test(`native host runs complete inventory and propagates ${mode} with owned cleanup`, async () => {
    const root = await mkdtemp(
      join(
        process.env.PROCESS_SCRATCH_ROOT ?? process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(),
        "wth-",
      ),
    );
    const driver = new ThreadFakeDriver(mode, { list: { ids } });
    try {
      const result = await runPageSuite(adapter(), () => driver, {
        resultPath: join(root, "result.json"),
        scratchRoot: root,
        port: "ephemeral",
        assets: {},
      });
      expect(result.required).toEqual(ids);
      expect(result.selected).toEqual(ids);
      expect(result.omitted).toEqual([]);
      expect(result.exit === 0).toBe(mode === "pass");
      expect(driver.stopCalls).toBeGreaterThan(0);
      if (mode === "pass") {
        expect(Object.keys(result.results)).toEqual(ids);
        expect(new Set(result.documents.map((item) => item.doc)).size).toBe(11);
        expect(result.documents.every((item) => item.cutoff !== null)).toBe(true);
        expect(result.cleanup.session.status).toBe("confirmed");
        expect(result.cleanup.scratch.status).toBe("confirmed");
      }
    } finally {
      await driver.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("native CLI parses before Playwright or producer and records exact platform precondition", async () => {
  const root = await mkdtemp(
    join(process.env.PROCESS_SCRATCH_ROOT ?? process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "wtc-"),
  );
  async function invoke(args: string[]) {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../threads-runtime-browser-runner.ts"),
        "ios-safari",
      ].concat(args),
      {
        env: { ...process.env, IOS_UDID: "", THREAD_FIXTURE_DIR: "", PROCESS_SCRATCH_ROOT: root },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const errors = await new Response(child.stderr).text();
      await new Response(child.stdout).text();
      return { exit: await child.exited, errors };
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  }
  try {
    const path = join(root, "result.json");
    expect((await invoke(["--result", path])).exit).toBe(3);
    expect(await Bun.file(path).json()).toEqual({
      suite: "threads-runtime",
      exit: 3,
      precondition: "Darwin and exact IOS_UDID required; no native resources allocated",
    });
    expect((await invoke(["--case", "pair", "--result", path])).exit).toBe(3);
    expect((await invoke(["--result", join(path, "bad.json")])).exit).toBe(2);
    expect(await readdir(root)).toEqual(["result.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
