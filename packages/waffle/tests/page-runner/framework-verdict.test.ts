import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFrameworkControl } from "./framework.js";
import { bounded } from "./driver.js";
import { record } from "./protocol.js";
import type { FrameworkEvent, FrameworkUpdate, VitestEnd } from "./framework-types.js";

type VerdictCase = {
  state: FrameworkUpdate["state"] | null;
  framework: VitestEnd;
  started?: boolean;
  exit: 2 | 4;
};
async function verdict(root: string, scenario: VerdictCase): Promise<void> {
  const resultPath = join(root, "result.json");
  const expected = {
    file: "original.ts",
    fullName: "required",
    sourceKey: "original:1",
    timeoutMs: 15000,
    retries: 0,
  } as const;
  const permit = Promise.withResolvers<unknown>();
  const cutoff = Promise.withResolvers<void>();
  let deletes = 0;
  const documents = new Map<string, ReturnType<typeof document>>();
  function document(kind: "orchestrator" | "tester", url: string) {
    const html = host.instrumentDocument({ kind, url, html: "<head></head>" });
    const config: unknown = JSON.parse(
      html.split("window.__waffleFrameworkConfiguration=")[1]?.split(";\n")[0] ?? "null",
    );
    if (!record(config) || typeof config.run !== "string" || typeof config.token !== "string")
      throw new Error("Missing real host document configuration");
    return {
      kind,
      url,
      run: config.run,
      token: config.token,
      doc: kind,
      ackedThrough: -1,
      pending: 0,
      valid: true,
      failure: null,
      contentClosed: true,
      paired: true,
    };
  }
  const native = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "DELETE") deletes++;
      let value: unknown = null;
      if (path === "/session")
        value = {
          sessionId: "verdict-control",
          capabilities: {
            browserName: "Safari",
            browserVersion: "CPU CONTROL ONLY",
            platformName: "iOS",
            "safari:useSimulator": true,
            "safari:deviceUDID": "not-launched",
          },
        };
      if (path.endsWith("/window")) value = "owned-window";
      if (path.endsWith("/window/handles")) value = ["owned-window"];
      if (path.endsWith("/execute/sync")) value = script(await request.json());
      return Response.json({ value });
    },
  });
  function script(body: unknown): unknown {
    if (!record(body) || typeof body.script !== "string") throw new Error("Invalid control script");
    const source = body.script;
    if (source.includes("bridge.testerSnapshot()")) return documents.get("tester");
    if (source.includes("bridge.snapshot()")) return documents.get("orchestrator");
    if (source.includes("bridge.capture()"))
      return {
        doc: "orchestrator",
        testerDoc: "tester",
        frame: { "element-6066-11e4-a52e-4f735466cecf": "owned-frame" },
      };
    if (source.includes("bridge.geometry()"))
      return {
        tester: { width: 414, height: 896, dpr: 1 },
        top: { width: 414, height: 896, visualWidth: 414, visualHeight: 896, scale: 1 },
        iframe: { x: 0, y: 0, width: 414, height: 896 },
      };
    if (source.includes("bridge.admit(")) {
      const args: unknown = JSON.parse(
        `[${source.split("bridge.admit(")[1]?.split(",undefined)")[0]}]`,
      );
      if (!Array.isArray(args) || typeof args[2] !== "string")
        throw new Error("Missing actual viewport permit");
      permit.resolve({ permit: args[2], width: 414, height: 896 });
    }
    if (source.includes("bridge.cutoff(")) cutoff.resolve();
    return true;
  }
  const host = createFrameworkControl(
    {
      suite: "verdict-cpu",
      native: { udid: "not-launched" },
      expected: [expected],
      scope: { kind: "root-selection", command: "test:browser", files: [expected.file] },
      resultPath,
    },
    `http://127.0.0.1:${native.port}/`,
  );
  const collector = createServer((request, response) =>
    host.middleware(request, response, () => response.writeHead(404).end()),
  );
  host.mount({ stack: [], use() {} });
  async function send(kind: "orchestrator" | "tester", body: object): Promise<void> {
    const state = documents.get(kind);
    if (!state) throw new Error("Missing control document");
    const response = await fetch(`${origin}/report`, {
      method: "POST",
      body: JSON.stringify({ ...state, seq: state.ackedThrough + 1, ...body }),
    });
    expect(response.status).toBe(200);
    const ack: unknown = await response.json();
    expect(ack).toEqual({ ackedThrough: state.ackedThrough + 1 });
    state.ackedThrough++;
  }
  async function waitForRetirement(kind: "orchestrator" | "tester"): Promise<void> {
    const state = documents.get(kind);
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
      const response = await fetch(`${origin}/retire?run=${state?.run}&doc=${kind}`);
      const reply: unknown = await response.json();
      expect(response.status).toBe(200);
      if (record(reply) && reply.kind === "live" && reply.retire === true) return;
      await Bun.sleep(1);
    }
    throw new Error("Control retirement readiness timed out");
  }
  const event = (kind: "orchestrator" | "tester", event: FrameworkEvent) =>
    send(kind, { kind: "event", event });
  let origin = "";
  try {
    await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
    const address = collector.address();
    if (!address || typeof address === "string") throw new Error("No owned collector listener");
    origin = `http://127.0.0.1:${address.port}`;
    const result = await host.run(async (registerClose) => {
      registerClose(async () => {});
      await host.attach({
        connect: async () => ({}),
        detach: () => host.detach(),
        frames: { isTestFrame: () => false, main: async () => {}, tester: async () => {} },
      });
      for (const kind of ["orchestrator", "tester"] as const) {
        const state = document(kind, `${origin}/${kind}`);
        documents.set(kind, state);
        await send(kind, { kind: "hello", role: kind, url: state.url });
      }
      await host.openPage(`${origin}/orchestrator`, async () => {});
      await host.initialViewport(await bounded(permit.promise, 2000, "Control admission"));
      await event("tester", {
        kind: "collected",
        tasks: [
          {
            id: "case",
            parentId: null,
            type: "test",
            file: expected.file,
            fullName: expected.fullName,
            mode: "run",
            timeoutMs: expected.timeoutMs,
            retries: 0,
          },
        ],
      });
      if (scenario.started !== false) await event("tester", { kind: "task-started", id: "case" });
      if (scenario.state !== null)
        await event("tester", {
          kind: "case-settled",
          updates: [
            {
              id: "case",
              state: scenario.state,
              errors: scenario.state === "fail" ? ["original assertion failure"] : [],
              hooks: {},
              retryCount: 0,
            },
          ],
        });
      await event("tester", { kind: "execution-flushed" });
      await event("tester", { kind: "tester-cleanup-settled" });
      await event("orchestrator", { kind: "cleanup-response-received" });
      await waitForRetirement("tester");
      await waitForRetirement("orchestrator");
      await send("tester", { kind: "retire-ready" });
      await send("orchestrator", { kind: "retire-ready" });
      await bounded(cutoff.promise, 2000, "Control final cutoff");
      await host.provider("framework-cleanup", async () => {});
      return scenario.framework;
    });
    expect(result.failures).toEqual([]);
    expect(result.framework).toEqual(scenario.framework);
    expect(result.cases[0]?.outcome?.state ?? null).toBe(scenario.state);
    expect(result.cases[0]?.outcome?.errors ?? []).toEqual(
      scenario.state === "fail" ? ["original assertion failure"] : [],
    );
    for (const document of result.documents) {
      expect(document.pending).toBe(0);
      expect(document.ackedThrough).toBe(document.acceptedThrough);
      expect(document.cutoff).toBeNumber();
    }
    for (const key of ["session", "callbacks", "provider", "context", "scratch"] as const)
      expect(result.cleanup[key].status).toBe("confirmed");
    expect(deletes).toBe(1);
    expect(result.rootBrowserSuiteComplete).toBe(false);
    const saved = JSON.parse(await readFile(resultPath, "utf8"));
    expect(saved).toEqual(result);
    expect({ exit: result.exit, fileComplete: result.fileComplete }).toEqual({
      exit: scenario.exit,
      fileComplete: scenario.exit === 4,
    });
  } finally {
    await host.abort("Control fixture teardown");
    await native.stop(true);
    collector.closeAllConnections();
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  }
}
const scenarios = [
  {
    state: "fail",
    framework: { status: "failed", errors: ["original assertion failure"] },
    exit: 2,
  },
  { state: "fail", framework: { status: "passed" }, exit: 2 },
  { state: "pass", framework: { status: "failed", errors: ["framework failure"] }, exit: 2 },
  { state: "pass", framework: { status: "interrupted", errors: [] }, exit: 2 },
  { state: "skip", framework: { status: "passed" }, exit: 2 },
  { state: "todo", framework: { status: "passed" }, exit: 2 },
  { state: null, framework: { status: "passed" }, exit: 2 },
  { state: "pass", started: false, framework: { status: "passed" }, exit: 2 },
  { state: "pass", framework: { status: "passed" }, exit: 4 },
] satisfies VerdictCase[];
for (const scenario of scenarios) {
  test(`framework verdict with ${scenario.state}, ${scenario.framework.status}, started=${scenario.started !== false}`, async () => {
    const prior = process.env.STORAGE_SCRATCH_ROOT;
    const root = await mkdtemp(join(prior ?? tmpdir(), "waffle-framework-verdict-"));
    process.env.STORAGE_SCRATCH_ROOT = root;
    try {
      await verdict(root, scenario);
    } finally {
      if (prior === undefined) delete process.env.STORAGE_SCRATCH_ROOT;
      else process.env.STORAGE_SCRATCH_ROOT = prior;
      await rm(root, { recursive: true, force: true });
    }
  });
}
