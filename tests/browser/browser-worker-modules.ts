// cd web && bun run build && node tests/browser-worker-modules.ts [chromium|webkit]
import assert from "node:assert/strict";
import type { Browser, BrowserContext } from "playwright";
import { playwright, session, ready, writeFile, run } from "./playground.mjs";
import { workerReviewCases } from "../../tests/fixtures/worker-review/cases.ts";

const atomic = workerReviewCases.find(test => test.name === "atomic-transfer");
assert.ok(atomic);
const s = session("bun-wasm-worker-modules-");
const deadline = setTimeout(() => { console.error("worker module gate timed out"); void s.cleanup().finally(() => process.exit(1)); }, 600_000);
const failures: string[] = [];

// Reproduce WebKit's uncontrolled descendant without depending on the timing of SW assignment.
function uncontrolledChildren() {
  const NativeWorker = globalThis.Worker;
  let root: Worker | null = null;
  globalThis.Worker = new Proxy(NativeWorker, {
    construct(target, args, newTarget) {
      const scoped = new URL(String(args[0]), location.href).pathname.endsWith("/__bunwasm/worker.js");
      if (scoped && root) args[0] = new URL("./worker.js", location.href).href;
      const worker: Worker = Reflect.construct(target, args, newTarget);
      if (!scoped || root) return worker;
      root = worker;
      const terminate = worker.terminate;
      worker.terminate = () => { root = null; return terminate.call(worker); };
      return worker;
    },
  });
}

try {
  const url = process.env.BUN_WASM_TEST_URL ?? await s.serve();
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "webkit"]) {
    assert.ok(name === "chromium" || name === "webkit", `unsupported browser: ${name}`);
    const browser: Browser = await s.launch(playwright[name]);
    const context = await browser.newContext();
    const moduleErrors: { url: string; status: number; fromServiceWorker: boolean }[] = [];
    const evalRequests: string[] = [];
    function observeModules(observed: BrowserContext) {
      observed.on("request", request => {
        if (decodeURIComponent(request.url()).endsWith("/[eval]")) evalRequests.push(request.url());
      });
      observed.on("response", response => {
        if (response.status() >= 400 && response.url().includes("/__bunwasm/m/")) moduleErrors.push({
          url: response.url(), status: response.status(), fromServiceWorker: response.fromServiceWorker(),
        });
      });
    }
    observeModules(context);
    const page = await context.newPage();
    await page.goto(`${url}?engine=browser`);
    assert.match(await ready(page), /ready/);
    await writeFile(page, "/home/user/worker-atomic.ts", atomic.code);
    for (let iteration = 1; iteration <= 20; iteration++) {
      const checked = await run(page, "bun run worker-atomic.ts", 120000);
      const passed = checked.code === atomic.exit && atomic.output.every(line => checked.output.includes(line));
      console.log(JSON.stringify({ browser: name, iteration, passed, ...checked }));
      if (!passed) failures.push(`${name} #${iteration}: exit ${checked.code}\n${checked.output}`);
    }
    await context.close();
    const uncontrolled = await browser.newContext();
    observeModules(uncontrolled);
    await uncontrolled.addInitScript(uncontrolledChildren);
    const uncontrolledPage = await uncontrolled.newPage();
    await uncontrolledPage.goto(`${url}?engine=browser`);
    assert.match(await ready(uncontrolledPage), /ready/);
    await writeFile(uncontrolledPage, "/home/user/worker-atomic.ts", atomic.code);
    const checked = await run(uncontrolledPage, "bun run worker-atomic.ts", 120000);
    const passed = checked.code === atomic.exit && atomic.output.every(line => checked.output.includes(line));
    console.log(JSON.stringify({ browser: name, uncontrolled: true, passed, ...checked }));
    if (!passed) failures.push(`${name} uncontrolled: exit ${checked.code}\n${checked.output}`);
    if (moduleErrors.length) failures.push(`${name}: module HTTP errors ${JSON.stringify(moduleErrors)}`);
    if (evalRequests.length) failures.push(`${name}: ${evalRequests.length} eval modules depended on HTTP`);
    console.log(`${name}: ${20 - failures.filter(failure => failure.startsWith(`${name} #`)).length}/20 atomic-transfer runs, ${moduleErrors.length} module HTTP errors, ${evalRequests.length} eval HTTP requests`);
    await browser.close();
  }
  assert.deepEqual(failures, []);
} finally { clearTimeout(deadline); await s.cleanup(); }
