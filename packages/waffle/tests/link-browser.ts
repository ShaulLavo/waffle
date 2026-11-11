import { prepareLinkPlan } from "../link/index.js";
import { MemoryGroups } from "../group/state.js";
import { source } from "./fixtures/link-initialization.js";
import { withMemberWorkers } from "./fixtures/link-member-workers.js";

function reply(worker: Worker): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => (data.error ? reject(new Error(data.error)) : resolve(data));
    worker.onerror = reject;
  });
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** @browserEntry */
export async function sharedLinkBrowser() {
  const plan = await prepareLinkPlan(source(true, true));
  const groups = new MemoryGroups({ stackBytes: 65536, maximumPages: 32 });
  const observations: Record<string, unknown>[] = [];
  await withMemberWorkers(async (start) => {
    let join: Parameters<MemoryGroups["admit"]>[2] = "new";
    for (let index = 0; index < 2; index++) {
      const member = start({
        groups,
        pid: index + 1,
        program: "shared-link",
        join,
        workerURL: new URL("/worker.js", location.href),
      });
      join = member.lease.group;
      const response = reply(member.worker);
      const launch = member.lease.launch();
      member.worker.postMessage(
        { kind: "launch", request: launch.request, mark: 100 + index, linkPlan: plan.shared },
        launch.transfer,
      );
      observations.push(await response);
    }
    for (const value of observations) {
      assert(value.compileControl === 1 && value.compileCalls === 0, "worker compiler controls");
      assert(value.frozen === true, "adopted metadata must be frozen");
      assert(value.memoryCoreMark === 42 && value.memorySideMark === 22, "memory stages");
      assert(value.sameStack === true, "side must borrow its core stack");
    }
    assert(observations[0]!.coreTls !== observations[1]!.coreTls, "private core state");
    assert(observations[0]!.sideTls !== observations[1]!.sideTls, "private side state");
    assert(
      observations[0]!.coreMark === 100 && observations[1]!.coreMark === 101,
      "independent marks",
    );
  });
  assert(groups.snapshot().length === 0 && groups.budget.committed === 0, "group cleanup");
  return { observations, cleanup: true };
}
