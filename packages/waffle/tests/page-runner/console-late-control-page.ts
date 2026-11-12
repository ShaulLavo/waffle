import { cleanupStorage, startPage } from "./consumer-page.js";
startPage<{ mode: string; marker: string }>({
  list: async () => ["console"],
  async run({ mode, marker }, _allocate, context) {
    const gate = context.fetchFixture("/console-late-gate");
    // The armed response proves admission before the body can pass.
    const armed = await context.fetchFixture("/console-late-armed");
    if (!armed.ok || (await armed.json()).armed !== true)
      throw new Error("Late Console arm failed");
    const url = new URL("/console-worker.js", location.href);
    url.searchParams.set("mode", "worker-only");
    url.searchParams.set("marker", marker);
    const worker = mode.startsWith("worker-") ? new Worker(url) : null;
    void gate
      .then(async (response) => {
        if (!response.ok || (await response.json()).released !== true)
          throw new Error(`Late Console gate failed: ${response.status}`);
        if (worker) worker.postMessage("log");
        else console.error(marker);
      })
      .catch((error: unknown) => console.error(`late-gate-failed: ${String(error)}`));
    return { body: "pass", mode, marker };
  },
  finish: cleanupStorage,
});
