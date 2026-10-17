import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createNodeSignalController } from "../scripts/node-signals.ts";
import { setSignalDisposition, takeSignal, createSignalState } from "../../runtime/proc/signals.ts";

for (const signal of [2, 15, 13]) {
  test(`Node root default ${signal} seals typed status before worker teardown`, () => {
    const parent = createNodeSignalController();
    const guest = createNodeSignalController(parent.buffers);
    expect(parent.request(signal).action).toBe("default");
    expect(guest.selected()).toEqual({ kind: "signaled", code: signal, status: 128 + signal });
    expect(guest.finish(0)).toEqual(parent.finish(1));
    expect(parent.finish(0).status).toBe(128 + signal);
  });
  test(`Node root handled ${signal} retains the guest's ordinary exit`, () => {
    const parent = createNodeSignalController();
    const guest = createNodeSignalController(parent.buffers);
    const state = createSignalState(parent.buffers.signalState);
    setSignalDisposition(state, signal, 2);
    expect(parent.request(signal).action).toBe("handled");
    expect(parent.selected()).toBeNull();
    expect(takeSignal(state)).toBe(signal);
    expect(takeSignal(state)).toBe(0);
    expect(guest.finish(143)).toEqual({ kind: "exited", code: 143, status: 143 });
    expect(parent.finish(0).kind).toBe("exited");
  });
}

test("Node root ignored requests do not select a terminal outcome", () => {
  const controller = createNodeSignalController();
  const state = createSignalState(controller.buffers.signalState);
  setSignalDisposition(state, 15, 1);
  expect(controller.request(15).action).toBe("ignore");
  expect(controller.selected()).toBeNull();
  expect(takeSignal(state)).toBe(0);
});

test("Node guest typed self-default remains distinct from ordinary 143", () => {
  const controller = createNodeSignalController();
  expect(controller.finish(143, 15)).toEqual({ kind: "signaled", code: 15, status: 143 });
  expect(controller.finish(0).kind).toBe("signaled");
  const ordinary = createNodeSignalController();
  expect(ordinary.finish(143)).toEqual({ kind: "exited", code: 143, status: 143 });
  expect(ordinary.request(9).action).toBe("settled");
});

test("Node ordinary exits are normalized before becoming shared outcomes", () => {
  expect(createNodeSignalController().finish(-1)).toEqual({ kind: "exited", code: 255, status: 255 });
  expect(createNodeSignalController().finish(256)).toEqual({ kind: "exited", code: 0, status: 0 });
});

test("Node distinct handled requests survive a single wake hint", () => {
  const controller = createNodeSignalController();
  const state = createSignalState(controller.buffers.signalState);
  setSignalDisposition(state, 2, 2);
  setSignalDisposition(state, 15, 2);
  controller.request(15); controller.request(2); controller.request(2);
  expect(takeSignal(state)).toBe(2);
  expect(takeSignal(state)).toBe(15);
  expect(takeSignal(state)).toBe(0);
  expect(controller.selected()).toBeNull();
});

// Run the actual adapter's terminal functions in real Node Workers. Unlike a VM mock or a
// throwable browser exit, Node's saved process.exit must be impossible for guest JS to catch.
const nodeHost = readFileSync(new URL("../scripts/node-host.mjs", import.meta.url), "utf8");
const terminalStart = nodeHost.indexOf("function checkFatal() {");
const terminalEnd = nodeHost.indexOf("function installStdio(", terminalStart);
if (terminalStart < 0 || terminalEnd < 0) throw new Error("Node terminal functions missing");
const terminalFunctions = nodeHost.slice(terminalStart, terminalEnd);
for (const mode of ["raise", "pending-removal", "checkpoint"]) test(`Node ${mode} cannot catch default and continue I/O or an endless loop`, () => {
  const controllerUrl = new URL("../scripts/node-signals.ts", import.meta.url).href;
  const subprocessUrl = new URL("../src/subprocess.ts", import.meta.url).href;
  const workerSource = `
    import { parentPort, workerData } from "node:worker_threads";
    (async () => {
      const { createNodeSignalController } = await import(${JSON.stringify(controllerUrl)});
      const { SubprocessHost } = await import(${JSON.stringify(subprocessUrl)});
      const signals = createNodeSignalController(workerData.buffers);
      new Function("signals", "nodeProcess", "child", "cliFetch", "SubprocessHost", "notify", ${JSON.stringify(`
        let subprocess;
        ${terminalFunctions}
        subprocess = new SubprocessHost({
          signalState: signals.buffers.signalState, outcome: signals.buffers.outcome,
          defaultSignal: signal => finish(128 + signal, signal),
        });
        notify("ready");
        try {
          ${mode === "raise" ? "subprocess.signal(15, 3);" : mode === "pending-removal"
            ? "subprocess.signal(15, 2); signals.request(15); subprocess.signal(15, 0);"
            : "signals.request(15); subprocess.signal(0, 0);"}
        } catch (error) { notify("caught"); }
        notify("forbidden I/O");
        for (;;) {}
      `)})(signals, process, null, null, SubprocessHost, value => parentPort.postMessage(value));
    })().catch(error => { console.error(error); process.exit(1); });
  `;
  const driver = `
    import { Worker } from "node:worker_threads";
    import { createNodeSignalController } from ${JSON.stringify(controllerUrl)};
    const signals = createNodeSignalController();
    const worker = new Worker(${JSON.stringify(workerSource)}, { eval: true, workerData: { buffers: signals.buffers } });
    const messages = [];
    worker.on("message", value => messages.push(value));
    let expired = false;
    const timer = setTimeout(() => { expired = true; void worker.terminate(); }, 2000);
    try {
      const status = await new Promise((resolve, reject) => { worker.once("exit", resolve); worker.once("error", reject); });
      console.log(JSON.stringify({ status, expired, messages, outcome: signals.selected() }));
    } finally { clearTimeout(timer); await worker.terminate(); }
  `;
  const result = spawnSync("node", ["--input-type=module", "-e", driver], { encoding: "utf8", timeout: 4000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    status: 143, expired: false, messages: ["ready"],
    outcome: { kind: "signaled", code: 15, status: 143 },
  });
});
