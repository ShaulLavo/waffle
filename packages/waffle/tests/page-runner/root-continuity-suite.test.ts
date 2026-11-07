import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rootContinuityControls,
  rootContinuityJSON,
  type RootContinuityRequest,
} from "../root-continuity-command.js";
import { rootContinuityStorage } from "./root-continuity-allocation.js";
import { rootContinuityAdapter, rootContinuityIds } from "./root-continuity-suite.js";
import { FakeDriver } from "./fake-driver.js";
import { record } from "./protocol.js";
import { runPageSuite, type RunOptions, type SuiteAdapter } from "./suite-host.js";

const evidence = {
  selected: {
    history: "actual-history",
    session: 65538,
    frontier: 131074,
    activations: 1,
    durabilityMs: 1,
    receiptCounts: { recovered: 2, settled: 3 },
    ledger: { changed: "9", allocated: 123, obligations: 0 },
  },
  cancel: {
    mode: "cancel",
    activations: 0,
    readyPublished: false,
    retainedBytes: 123,
    stopped: true,
  },
  failure: {
    mode: "failure",
    activations: 0,
    readyPublished: false,
    retainedBytes: 123,
    stopped: true,
  },
};
class RootDriver extends FakeDriver {
  constructor() {
    super("pass", { list: { ids: rootContinuityIds } });
  }
  protected override async run(role: unknown, request: unknown): Promise<void> {
    if (role !== "case") return super.run(role, request);
    if (!record(request)) throw new Error("Missing fake root request");
    const control = rootContinuityControls.find((name) => name === request.control);
    if (!control || typeof request.run !== "string") throw new Error("Wrong fake root control");
    const caseId = `root-continuity: ${control}`;
    await this.send({ kind: "case-start", caseId });
    for (let open = 0; open < (control === "selected" ? 3 : 1); open++)
      await this.send({
        kind: "allocation",
        entry: { kind: "indexeddb", name: `root-continuity-${control}-${request.run}` },
      });
    await this.send({ kind: "case-end", caseId, status: "pass", result: evidence[control] });
    await this.completeDocument();
  }
}
async function host(
  options: Partial<RunOptions> = {},
  adapter: SuiteAdapter<RootContinuityRequest> = rootContinuityAdapter,
) {
  const root = await mkdtemp(join(tmpdir(), "rc-host-"));
  let allocations = 0;
  const driver = new RootDriver();
  try {
    const resultPath = join(root, "result.json");
    const result = await runPageSuite(
      adapter,
      () => {
        allocations++;
        return driver;
      },
      {
        assets: {},
        resultPath,
        scratchRoot: root,
        budgets: { hello: 500, heartbeat: 500, case: 1000, group: 1500, run: 8000 },
        ...options,
      },
    );
    expect(await Bun.file(resultPath).json()).toEqual(result);
    expect(await readdir(root)).toEqual(["result.json"]);
    return { result, allocations, driver };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("root continuity inventory is exactly the original three controls with one command clock", () => {
  expect(rootContinuityControls).toEqual(["selected", "cancel", "failure"]);
  expect(rootContinuityAdapter.inventory().map((item) => item.request("run"))).toEqual(
    rootContinuityControls.map((control) => ({ run: "run", control })),
  );
  for (const selected of [0, 1, 3])
    expect(rootContinuityAdapter.budgets(selected)).toEqual({
      hello: 20_000,
      heartbeat: 10_000,
      case: 150_000,
      group: 150_000,
      run: 150_000,
    });
  for (const ids of [
    [],
    rootContinuityIds.slice(0, 1),
    rootContinuityIds.toReversed(),
    rootContinuityIds.concat(rootContinuityIds),
  ])
    expect(() => rootContinuityAdapter.policy.listIds({ ids })).toThrow();
  expect(rootContinuityAdapter.policy.listIds({ ids: rootContinuityIds })).toEqual(
    rootContinuityIds,
  );
});
test("host validation rejects missing evidence and non-console bigint formatting", () => {
  const check = rootContinuityAdapter.policy.check;
  for (const actual of [
    null,
    {},
    { ...evidence.selected, ledger: { changed: 9 } },
    { ...evidence.selected, receiptCounts: {} },
    { ...evidence.selected, activations: 0 },
  ])
    expect(() => check(rootContinuityIds[0]!, actual)).toThrow();
  for (const control of ["cancel", "failure"] as const) {
    const id = `root-continuity: ${control}`;
    expect(() => check(id, evidence[control])).not.toThrow();
    expect(() => check(id, { ...evidence[control], stopped: false })).toThrow();
    expect(() => check(id, { ...evidence[control], mode: "selected" })).toThrow();
  }
});
test("console evidence preserves actual nested bigint strings", () => {
  expect(
    rootContinuityJSON({
      control: "selected",
      evidence: { ledger: { changed: 18446744073709551615n }, values: [0n, -1n] },
    }),
  ).toBe(
    '{"control":"selected","evidence":{"ledger":{"changed":"18446744073709551615"},"values":["0","-1"]}}',
  );
});
test("all three reports retire in order and repeated opens deduplicate only exact ledger names", async () => {
  const { result, driver } = await host();
  expect(result.exit).toBe(0);
  expect(result.required).toEqual(rootContinuityIds);
  expect(result.selected).toEqual(rootContinuityIds);
  expect(result.omitted).toEqual([]);
  expect(result.results).toEqual(
    Object.fromEntries(
      rootContinuityControls.map((control, i) => [rootContinuityIds[i], evidence[control]]),
    ),
  );
  expect(result.documents.map((doc) => doc.group)).toEqual(
    ["list"].concat(rootContinuityIds, ["finish"]),
  );
  expect(result.documents.every((doc) => doc.doc && doc.cutoff !== null)).toBe(true);
  expect(result.ledger).toEqual(
    rootContinuityControls.map((control) => ({
      kind: "indexeddb",
      name: `root-continuity-${control}-${result.run}`,
    })),
  );
  expect(result.storageRemaining).toEqual([]);
  expect(result.cleanup.storage.status).toBe("confirmed");
  expect(driver.stopCalls).toBe(1);
});
test("filtered selection keeps the complete denominator and cannot claim a full pass", async () => {
  const { result } = await host({ filter: "selected" });
  expect(result.exit).toBe(4);
  expect(result.required).toEqual(rootContinuityIds);
  expect(result.selected).toEqual(rootContinuityIds.slice(0, 1));
  expect(result.omitted).toEqual(rootContinuityIds.slice(1));
});
test("expired original clock prevents preparation and every driver constructor", async () => {
  let preparations = 0;
  const adapter = {
    ...rootContinuityAdapter,
    async assets() {
      preparations++;
      return {};
    },
  };
  const { result, allocations } = await host(
    {
      assets: undefined,
      startedAt: performance.now() - 150_001,
      budgets: rootContinuityAdapter.budgets(3),
    },
    adapter,
  );
  expect(preparations).toBe(0);
  expect(allocations).toBe(0);
  expect(result.exit).toBe(2);
  expect(result.failures.some((item) => item.category === "run-timeout")).toBe(true);
});
test("asset preparation consumes the same clock before driver construction", async () => {
  let prepared = false;
  const adapter = {
    ...rootContinuityAdapter,
    async assets({ signal }: { signal: AbortSignal }) {
      await Bun.sleep(80);
      prepared = true;
      signal.throwIfAborted();
      return {};
    },
  };
  const { result, allocations } = await host(
    {
      assets: undefined,
      budgets: { hello: 500, heartbeat: 500, case: 1000, group: 1500, run: 40 },
    },
    adapter,
  );
  expect(prepared).toBe(true);
  expect(allocations).toBe(0);
  expect(result.exit).toBe(2);
  expect(result.cleanup.scratch.status).toBe("confirmed");
});
test("allocation rejects wrong kinds, names, controls, and run identities", () => {
  const allocation = rootContinuityAdapter.policy.allocation!;
  const entry = { kind: "indexeddb", name: "root-continuity-selected-run" } as const;
  expect(() => allocation(entry, [rootContinuityIds[0]!], "run")).not.toThrow();
  for (const [running, run] of [
    [[], "run"],
    [[rootContinuityIds[1]!], "run"],
    [[rootContinuityIds[0]!], "other"],
    [rootContinuityIds, "run"],
  ] as const)
    expect(() => allocation(entry, running, run)).toThrow();
  expect(() =>
    allocation({ kind: "opfs-directory", name: entry.name }, [rootContinuityIds[0]!], "run"),
  ).toThrow();
  expect(() =>
    allocation({ ...entry, name: entry.name + "-unrelated" }, [rootContinuityIds[0]!], "run"),
  ).toThrow();
});
test("a stale document cannot even send an allocation request", async () => {
  let sent = 0;
  const storage = rootContinuityStorage(
    { run: "run", control: "selected" },
    async () => {
      sent++;
    },
    () => false,
  );
  await expect(storage.allocate({ kind: "indexeddb", name: storage.name() })).rejects.toThrow(
    "document is no longer current",
  );
  expect(sent).toBe(0);
});

async function invoke(root: string, args: string[]): Promise<number> {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../root-continuity-browser-runner.ts"),
      "ios-safari",
    ].concat(args),
    {
      env: { ...process.env, IOS_UDID: "", STORAGE_SCRATCH_ROOT: root, TMPDIR: root },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  try {
    return await child.exited;
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}
test("early native precondition and invalid CLI allocate no desktop or native resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "rc-cli-"));
  try {
    const resultPath = join(root, "result.json");
    expect(await invoke(root, ["--result", resultPath])).toBe(3);
    expect(await Bun.file(resultPath).json()).toEqual({
      suite: "root-continuity",
      exit: 3,
      precondition: "Darwin and exact IOS_UDID required; no native resources allocated",
    });
    expect(await readdir(root)).toEqual(["result.json"]);
    expect(await invoke(root, ["--result", "relative.json"])).toBe(3);
    expect(await invoke(root, ["--result", join(resultPath, "unwritable.json")])).toBe(2);
    expect(await readdir(root)).toEqual(["result.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
