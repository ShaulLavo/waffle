import { BrowserProcessBroker } from "../browser/process-broker.ts";
import { createFilesystemIdentity } from "../fs/protocol.ts";
import { ProcessIdentityAllocator } from "../proc/identity.ts";
import { ProcessTable } from "../proc/table.ts";
import { ExecutableRegistry } from "../proc/registry.ts";
import { createWorkerProcessTransport } from "../proc/worker-client.ts";
import { groupLinkProgram } from "./fixtures/group-link-program.ts";
import { testReservations } from "./fixtures/shared-memory-platform.ts";
import { MemoryGroups } from "../group/state.ts";
import type { MemoryGroupMemberRequest } from "../group/protocol.ts";

function consumer(
  request: MemoryGroupMemberRequest,
  transfer: readonly Transferable[],
  width: 4 | 8,
  gated: boolean,
) {
  const worker = new Worker("/worker.js", { type: "module" });
  const gate = gated ? new Int32Array(new SharedArrayBuffer(4)) : undefined;
  const entered = Promise.withResolvers<void>();
  let terminated = false;
  let gateReceipt: { closed: number; closedReads: number; width: number } | null = null;
  worker.onmessage = ({ data }) => {
    if (!gated && data.event === "native-entry") entered.resolve();
    if (gated && data.event === "gate") {
      gateReceipt = {
        closed: Number(data.closed),
        closedReads: Number(data.closedReads),
        width: Number(data.width),
      };
      entered.resolve();
    }
  };
  worker.onerror = (event) => entered.reject(new Error(event.message));
  worker.postMessage(
    { request, width, addr: 64, ...(gate ? { stage: "pre-wait", gate: gate.buffer } : {}) },
    Array.from(transfer),
  );
  return {
    entered: entered.promise,
    terminate() {
      if (terminated) return;
      terminated = true;
      worker.terminate();
    },
    finish() {
      if (gate) {
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
      }
      worker.onmessage = null;
      worker.onerror = null;
      request.port.close();
      return gateReceipt;
    },
  };
}

/** @browserEntry Returns only scalars. Passive observation starts after this frame returns. */
export async function passiveRoot(width: 4 | 8, gated = false) {
  let native: ReturnType<typeof consumer> | undefined;
  const identities = new ProcessIdentityAllocator();
  const broker = new BrowserProcessBroker({
    reservations: testReservations(),
    identities,
    table: new ProcessTable(identities),
    registry: new ExecutableRegistry(),
    filesystem: {
      connect() {
        throw new Error("unused");
      },
      revoke() {},
      reap() {},
      async quiesce() {},
    },
    launch() {
      throw new Error("unused");
    },
  });
  const root = createWorkerProcessTransport({ identity: identities.buffer });
  root.data = { filesystem: createFilesystemIdentity() };
  await broker.adoptRuntimeRoot(root, {
    memory: "group",
    stop() {
      native!.terminate();
    },
  });
  const group = broker.admitRootMemoryGroup(root.pid, await groupLinkProgram());
  try {
    native = consumer(group.request, group.transfer, width, gated);
    await native.entered;
    await broker.dispose();
    return {
      width,
      gate: native.finish(),
      nativeInvoked: true,
      groups: broker.memoryGroups().length,
    };
  } finally {
    native?.terminate();
    native?.finish();
    await broker.dispose();
  }
}

/** @browserEntry Staggered retirement with only scalar results retained. */
export async function passiveStaggered(width: 4 | 8) {
  const groups = new MemoryGroups();
  const a = groups.admit(1, "passive", "new"),
    b = groups.admit(2, "passive", a.group);
  const la = a.launch(),
    lb = b.launch();
  const first = consumer(la.request, la.transfer, width, false);
  const second = consumer(lb.request, lb.transfer, width, false);
  try {
    await first.entered;
    await second.entered;
    try {
      first.terminate();
    } finally {
      a.stopRequested();
    }
    a.stopped();
    try {
      second.terminate();
    } finally {
      b.stopRequested();
    }
    b.stopped();
    first.finish();
    second.finish();
    return { width, nativeInvoked: 2, groups: groups.snapshot().length };
  } finally {
    first.terminate();
    second.terminate();
    first.finish();
    second.finish();
    a.stopped();
    b.stopped();
  }
}
