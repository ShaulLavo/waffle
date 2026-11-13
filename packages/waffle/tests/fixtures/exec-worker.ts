import {
  bootstrap,
  preview1Executor,
  type RuntimeWorkerRequest,
  type RuntimeWorkerHost,
} from "../../browser/worker.js";
import { linkedWorkerHooks, type SharedLinkPlan } from "../../link/index.js";

export function runExecWorker(
  request: RuntimeWorkerRequest & { linkPlan?: SharedLinkPlan },
  host?: RuntimeWorkerHost,
) {
  if (!request.linkPlan)
    return bootstrap(
      request,
      {
        ...preview1Executor,
        instantiated() {
          if (request.env.INJECT === "adapter") throw new Error("adapter setup refused");
        },
      },
      host,
    );
  return bootstrap(
    { ...request, linkPlan: request.linkPlan },
    {
      ...linkedWorkerHooks(),
      namespaces: () => ({ test: { check() {} } }),
      run: (_context, exited) => exited ?? 0,
    },
    host,
  );
}
