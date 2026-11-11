import { prepareLinkPlan } from "../../link/index.js";
import { pieCore } from "./memory-group-pie.js";

export async function groupLinkProgram() {
  const plan = await prepareLinkPlan({
    core: {
      id: "core",
      source: pieCore([0x10, 0]),
      cooperative: true,
      checkpoint: { module: "env", name: "check" },
      initializeMemory: [],
      initialize: [],
    },
    libraries: [],
    reserve: "reserve",
  });
  return { module: plan.entryModule, linkPlan: plan.shared };
}
