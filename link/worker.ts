import type { RuntimeWorkerRequest, WorkerExecutor } from "../browser/worker.js";
import {
  instantiateLinkPlan,
  prepareLinkPlan,
  type LinkPlanSource,
  type LinkedGroup,
} from "./index.js";

export interface LinkedWorkerRequest extends RuntimeWorkerRequest {
  readonly linkPlan: LinkPlanSource;
}

/** Compose these hooks into the ordinary executor. Its beforeFinish must call ours. */
export function linkedWorkerHooks(): Pick<
  WorkerExecutor<LinkedWorkerRequest>,
  "instantiate" | "initialize" | "beforeFinish"
> {
  let group: LinkedGroup | undefined;
  let finished = false;
  return {
    async instantiate(imports, context) {
      context.checkActive();
      if (finished || group) throw new Error("link executor already used");
      const plan = await prepareLinkPlan(context.request.linkPlan);
      context.checkActive();
      if (finished) throw new Error("link executor finished during admission");
      group = instantiateLinkPlan(plan, {
        wasi: context.wasi,
        coreImports: imports,
        checkActive: context.checkActive,
        bindMemory: context.bindMemory,
      });
      return group.entry;
    },
    initialize(context) {
      context.checkActive();
      if (!group || finished) throw new Error("link group is unavailable");
      group.initialize();
    },
    beforeFinish() {
      finished = true;
      const owned = group;
      group = undefined;
      owned?.dispose();
    },
  };
}
