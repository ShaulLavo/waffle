import { resolve } from "node:path";
import type { HostCase, SuiteAdapter } from "waffle/testing/page-runner";
import { asyncFixture, asyncRoutes } from "../gpu-async-assets.js";
import { browserBundle } from "../browser-runner-lifecycle.js";
import {
  runAsyncSuite,
  requireCompleteAsyncResult,
  admitAsync,
  type AsyncCommand,
} from "../gpu-async-command.js";
import { gpuAsyncId, type GpuAsyncEngine, type GpuAsyncRequest } from "./gpu-async-request.js";
import { record, strings } from "./protocol.js";

export async function driveGpuAsync(host: HostCase, engine: GpuAsyncEngine) {
  host.signal.throwIfAborted();
  await host.task("window.__gpuAsync.value = await window.__gpuAsync.capabilities();");
  const qualification = await host.script("return window.__gpuAsync.value;");
  const { available, adapter } = admitAsync(engine, qualification);
  const command: AsyncCommand = {
    async invoke(name, args) {
      await host.task(
        `window.__gpuAsync.value = await window.__gpuAsync.invoke(${JSON.stringify(name)}, ${JSON.stringify(args)});`,
      );
      return host.script("return window.__gpuAsync.value;");
    },
    sleep: (ms) => host.sleep(ms),
  };
  const result = available
    ? await runAsyncSuite(command, adapter)
    : { status: "unsupported", compiledGuest: false };
  return { engine, qualification, adapter, ...result };
}
export function checkGpuAsyncResult(engine: GpuAsyncEngine, result: unknown): void {
  if (
    !record(result) ||
    !record(result.body) ||
    result.body.status !== "pass" ||
    !record(result.body.result) ||
    !record(result.teardown) ||
    result.teardown.status !== "pass" ||
    !record(result.teardown.result)
  )
    throw new Error("Missing complete GPU async command result or teardown");
  const body = result.body.result,
    cleanup = result.teardown.result;
  if (body.engine !== engine) throw new Error("Wrong GPU async engine");
  const { available, adapter } = admitAsync(engine, body.qualification);
  if (cleanup.qualificationClosed !== true) throw new Error("Qualification worker was not closed");
  if (!available) {
    if (
      body.status !== "unsupported" ||
      body.compiledGuest !== false ||
      cleanup.asyncStarted !== false ||
      cleanup.closeAttempted !== false ||
      cleanup.closed !== null
    )
      throw new Error("Unsupported GPU was relabeled compiled acceptance");
    return;
  }
  requireCompleteAsyncResult(body, adapter);
  if (
    body.status !== "passed" ||
    body.compiledGuest !== true ||
    cleanup.asyncStarted !== true ||
    cleanup.closeAttempted !== true ||
    !record(cleanup.closed) ||
    !Array.isArray(cleanup.closed.errors) ||
    cleanup.closed.errors.length ||
    !Array.isArray(cleanup.closed.workers) ||
    !cleanup.closed.workers.length ||
    cleanup.closed.workers.some((worker) => !record(worker) || worker.stopped !== true)
  )
    throw new Error("Compiled GPU async command or original cleanup did not finish");
}
export function gpuAsyncAdapter(engine: GpuAsyncEngine): SuiteAdapter<GpuAsyncRequest> {
  return {
    suite: "gpu-async",
    inventory: () => [
      {
        id: gpuAsyncId,
        label: "compiled command",
        request: () => ({ engine }),
        drive: (host) => driveGpuAsync(host, engine),
      },
    ],
    policy: {
      requireResult: true,
      listIds(value) {
        if (
          !record(value) ||
          Object.keys(value).length !== 1 ||
          !strings(value.ids) ||
          value.ids.length !== 1 ||
          value.ids[0] !== gpuAsyncId
        )
          throw new Error("Wrong complete GPU async command inventory");
        return value.ids;
      },
      check: (_id, result) => checkGpuAsyncResult(engine, result),
    },
    async assets({ signal }) {
      signal.throwIfAborted();
      const wasm = asyncFixture();
      const routes = await asyncRoutes(wasm, signal);
      delete routes["/"];
      routes["/page.js"] = await browserBundle(resolve(import.meta.dir, "gpu-async-page.ts"));
      signal.throwIfAborted();
      return routes;
    },
    budgets: () => ({
      hello: 20_000,
      heartbeat: 10_000,
      operation: 30_000,
      case: 600_000,
      group: 600_000,
      run: 600_000,
      teardown: 30_000,
    }),
  };
}
