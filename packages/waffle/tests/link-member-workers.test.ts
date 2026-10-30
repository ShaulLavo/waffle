import { expect, test } from "bun:test";
import { MemoryGroups, type MemberLease } from "../group/state.js";
import { withMemberWorkers } from "./fixtures/link-member-workers.js";

const workerURL = new URL("./fixtures/link-initialization-worker.ts", import.meta.url);
function owner(): MemoryGroups {
  return new MemoryGroups({ stackBytes: 65536, maximumPages: 32, budgetBytes: 32 * 65536 });
}
function failSecondConstruction(state: { attempts: number; stopped: boolean; error: Error }) {
  return (url: URL): Worker => {
    if (++state.attempts === 2) throw state.error;
    const worker = new Worker(url.href);
    const terminate = worker.terminate.bind(worker);
    worker.terminate = async () => {
      await terminate();
      state.stopped = true;
    };
    return worker;
  };
}

test("member setup closes the first Worker and unstarted reservation after second construction fails", async () => {
  const groups = owner();
  const state = { attempts: 0, stopped: false, error: new Error("second constructor failed") };
  await expect(
    withMemberWorkers(
      async (start) => {
        const first = start({ groups, pid: 101, program: "cleanup", join: "new", workerURL });
        start({ groups, pid: 102, program: "cleanup", join: first.lease.group, workerURL });
      },
      {
        createWorker: failSecondConstruction(state),
        beforeStopped() {
          expect(state.stopped).toBe(true);
        },
      },
    ),
  ).rejects.toBe(state.error);
  expect(state.attempts).toBe(2);
  expect(state.stopped).toBe(true);
  expect(groups.snapshot()).toEqual([]);
  expect(groups.budget.committed).toBe(0);
});

function failTermination(state: { error: Error; rescue?: () => Promise<void> }) {
  return (url: URL): Worker => {
    const worker = new Worker(url.href);
    const terminate = worker.terminate.bind(worker);
    state.rescue = async () => {
      await terminate();
    };
    worker.terminate = () => {
      throw state.error;
    };
    return worker;
  };
}

test("fixture termination failure keeps its lease until observed physical stop", async () => {
  const groups = owner();
  const error = new Error("termination not observed");
  let lease: MemberLease | undefined;
  const state: { error: Error; rescue?: () => Promise<void> } = { error };
  try {
    await expect(
      withMemberWorkers(
        async (start) => {
          lease = start({ groups, pid: 101, program: "debt", join: "new", workerURL }).lease;
        },
        {
          createWorker: failTermination(state),
        },
      ),
    ).rejects.toBe(error);
    expect(groups.snapshot()).not.toEqual([]);
    expect(groups.budget.committed).toBeGreaterThan(0);
  } finally {
    await state.rescue?.();
    lease?.stopped();
  }
  expect(groups.snapshot()).toEqual([]);
  expect(groups.budget.committed).toBe(0);
});
