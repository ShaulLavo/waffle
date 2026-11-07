import assert from "node:assert/strict";
import type { HostPeer } from "./page-runner/protocol.js";
import type { StorageLockScenario } from "./storage-lock-cases.js";
import {
  CasePeers,
  invoke,
  object,
  probes,
  query,
  ready,
  waiting,
  wait,
  waitState,
  waitProbe,
  lockName,
} from "./storage-lock-peer.js";

async function durable(
  peers: CasePeers,
  mode: "contested" | "earlyReload" | "crashedOwner",
): Promise<void> {
  const { host, backend, name } = peers;
  const owner = await peers.open("wait");
  await ready(host, owner, `${mode} owner`);
  assert.equal(await invoke(owner, "seed", []), "durable marker");
  let waiter = await peers.open(mode === "contested" && backend === "opfs" ? undefined : "wait");
  await waiting(host, waiter, `${mode} waiter`);
  if (mode === "contested") {
    assert.ok(
      (await query(waiter)).pending.some((lock) => lock.name === lockName(backend, name)),
      "Waiter did not queue the actual Web Lock",
    );
    await invoke(owner, "dispose", []);
  }
  await peers.close(owner);
  if (mode === "earlyReload") {
    waiter = await peers.reload(waiter);
    await invoke(waiter, "start", [backend, name, "wait"]);
  }
  await ready(host, waiter, `${mode} waiter after handoff`);
  assert.equal(
    await invoke(waiter, "readSaved", []),
    "durable marker",
    `${backend} ${mode} lost flushed data`,
  );
}
async function cancel(peers: CasePeers): Promise<void> {
  const { host, backend, name } = peers;
  const owner = await peers.open("wait");
  await ready(host, owner, "cancel owner");
  const waiter = await peers.open("wait");
  await waiting(host, waiter, "cancel waiter");
  await invoke(waiter, "beginWrite", ["must never be replayed"]);
  await invoke(waiter, "dispose", []);
  await invoke(waiter, "dispose", []);
  await wait(host, waiter, "window.lockTest.operation().status === 'rejected'");
  assert.equal(
    (await object(waiter, "operation", [])).errno,
    11,
    "Cancelled guest work must reject with ECANCELED",
  );
  assert.equal((await object(waiter, "state", [])).status, "disposed");
  assert.equal(
    await waiter.script(
      "return window.lockTest.states().filter(item => item.status === 'disposed').length;",
    ),
    1,
  );
  const resources = await object(waiter, "resources", []);
  assert.equal(resources.terminations, 1);
  assert.equal(resources.clientDisposals, 1);
  const third = await peers.create();
  assert.ok(
    !(await query(third)).pending.some((lock) => lock.name === lockName(backend, name)),
    "Cancelled waiter left a queued lock request",
  );
  await invoke(owner, "dispose", []);
  await invoke(third, "lockBarrier", [backend, name]);
  await invoke(third, "start", [backend, name, "wait"]);
  await ready(host, third, "third after cancelled waiter");
  assert.equal(await invoke(third, "readQueued", []), undefined, "Cancelled mutation replayed");
}
async function fifo(peers: CasePeers): Promise<void> {
  const { host, backend, name } = peers;
  const owner = await peers.open("wait");
  await ready(host, owner, "FIFO owner");
  const waiters: HostPeer[] = [];
  for (let index = 0; index < 3; index++) {
    const waiter = await peers.open("wait");
    waiters.push(waiter);
    await waiting(host, waiter, `FIFO waiter ${index}`);
    const snapshot = await query(waiter);
    assert.equal(
      snapshot.pending.filter((lock) => lock.name === lockName(backend, name)).length,
      index + 1,
      `FIFO request ${index} was not queued before successor`,
    );
  }
  await invoke(owner, "dispose", []);
  for (const [index, waiter] of waiters.entries()) {
    await ready(host, waiter, `FIFO waiter ${index} ownership`);
    await laterWaiters(waiters.slice(index + 1), index);
    await invoke(waiter, "dispose", []);
  }
}
async function laterWaiters(waiters: readonly HostPeer[], owner: number): Promise<void> {
  for (const peer of waiters)
    assert.equal(
      (await object(peer, "state", [])).status,
      "waiting",
      `Later waiter acquired while ${owner} owned the lock`,
    );
}
async function guest(peers: CasePeers): Promise<void> {
  const { host, backend } = peers;
  const owner = await peers.open("wait");
  await ready(host, owner, "guest-work owner");
  const waiter = await peers.open("wait");
  await waiting(host, waiter, "guest-work waiter");
  await invoke(waiter, "beginWrite", ["queued until ownership"]);
  assert.equal(
    (await object(waiter, "operation", [])).status,
    "pending",
    "Guest mutation ran before ownership",
  );
  await invoke(owner, "dispose", []);
  await ready(host, waiter, "guest-work waiter ownership");
  await wait(host, waiter, "window.lockTest.operation().status === 'fulfilled'");
  assert.equal(
    await invoke(waiter, "readQueued", []),
    "queued until ownership",
    `${backend} queued mutation did not run`,
  );
}
async function takeover(peers: CasePeers, policy: "default" | "takeover"): Promise<void> {
  const owner = await peers.open();
  await ready(peers.host, owner, "takeover owner");
  const contender = await peers.open(policy === "default" ? undefined : policy);
  await ready(peers.host, contender, "takeover contender");
  await wait(peers.host, owner, "window.lockTest.state().status === 'failed'");
  assert.match(String((await object(owner, "state", [])).error), /opened in another tab/);
  assert.equal(
    await invoke(contender, "seed", []),
    "durable marker",
    "Takeover owner cannot write after stealing",
  );
}
async function startupDisposed(owner: HostPeer): Promise<void> {
  const disposal = await object(owner, "disposal", []);
  assert.equal(disposal.status, "fulfilled", "Startup ownership loss stranded disposal");
  assert.equal(disposal.samePromise, true);
  await invoke(owner, "dispose", []);
  const resources = await object(owner, "resources", []);
  assert.equal(resources.terminations, 1);
  assert.equal(resources.clientDisposals, 1);
}
async function retainedReadyOwner(owner: HostPeer): Promise<void> {
  const disposal = await object(owner, "disposal", []);
  const state = await object(owner, "state", []);
  const resources = await object(owner, "resources", []);
  const received = await probes(owner);
  assert.equal(
    disposal.status,
    "rejected",
    "Ready ownership loss replaced original disposal failure",
  );
  assert.equal(disposal.samePromise, true);
  assert.equal(disposal.sameFailure, true);
  assert.equal(state.status, "failed");
  assert.equal(resources.terminations, 0);
  assert.equal(resources.clientDisposals, 0);
  assert.ok(!received.includes("probe-dispose-received"), "Ready loss invented a dispose receipt");
  assert.ok(!received.includes("filesystem-disposed"), "Ready loss invented a cleanup ACK");
}
export async function recovery(
  peers: CasePeers,
  timing: "disposing" | "recovering" | "ready",
  observe: (owner: HostPeer) => Promise<void> = freshObservation,
): Promise<void> {
  const { host, name } = peers;
  const owner = await peers.open("wait", true);
  await waitProbe(host, owner, "probe-recovery");
  assert.ok(
    (await query(owner)).held.some((lock) => lock.name === lockName("indexeddb", name)),
    "Recovery gate lacks actual workspace lock",
  );
  const gated = await object(owner, "state", []);
  assert.ok(gated.status === "opening" || gated.status === "waiting", "Gated owner left startup");
  await beforeLoss(peers, owner, timing);
  const successor = await peers.open();
  await waitProbe(host, owner, "filesystem-ownership-lost");
  if (timing !== "ready") await invoke(owner, "releaseRecovery", []);
  await afterLoss(peers, owner, timing);
  if (timing !== "ready") await startupDisposed(owner);
  await ready(host, successor, "takeover successor");
  if (timing !== "ready") {
    await rejectedRecovery(peers, owner, successor, timing);
    return;
  }
  assert.equal(
    await invoke(successor, "readSaved", []),
    "durable marker",
    "Ready owner's flushed data did not survive takeover",
  );
  await retainedReadyOwner(owner);
  await observe(owner);
  await peers.close(owner);
}
async function beforeLoss(
  peers: CasePeers,
  owner: HostPeer,
  timing: "disposing" | "recovering" | "ready",
): Promise<void> {
  if (timing === "ready") {
    await invoke(owner, "releaseRecovery", []);
    await ready(peers.host, owner, "owner after gated recovery");
    await invoke(owner, "seed", []);
    return;
  }
  await invoke(owner, "beginWrite", ["must never be replayed"]);
  assert.equal(
    (await object(owner, "operation", [])).status,
    "pending",
    "Guest work escaped gated recovery",
  );
  if (timing !== "disposing") return;
  await invoke(owner, "beginDispose", []);
  await waitProbe(peers.host, owner, "probe-dispose-received");
  assert.equal((await object(owner, "disposal", [])).status, "pending");
  assert.equal(
    (await object(owner, "resources", [])).terminations,
    0,
    "Startup disposal released recovering Worker",
  );
}
async function afterLoss(
  peers: CasePeers,
  owner: HostPeer,
  timing: "disposing" | "recovering" | "ready",
): Promise<void> {
  if (timing === "disposing") {
    await wait(peers.host, owner, "window.lockTest.disposal().status !== 'pending'");
    assert.equal((await object(owner, "disposal", [])).status, "fulfilled");
    await waitProbe(peers.host, owner, "filesystem-disposed");
    assert.equal((await object(owner, "state", [])).status, "disposed");
    return;
  }
  await waitState(peers.host, owner, "failed");
  assert.match(String((await object(owner, "state", [])).error), /opened in another tab/);
  await invoke(owner, "beginDispose", []);
  await wait(peers.host, owner, "window.lockTest.disposal().status !== 'pending'");
}
async function rejectedRecovery(
  peers: CasePeers,
  owner: HostPeer,
  successor: HostPeer,
  timing: "disposing" | "recovering",
): Promise<void> {
  await wait(peers.host, owner, "window.lockTest.operation().status === 'rejected'");
  const operation = await object(owner, "operation", []);
  if (timing === "disposing") assert.equal(operation.errno, 11);
  else assert.match(String(operation.error), /opened in another tab/);
  assert.equal(
    await invoke(successor, "readQueued", []),
    undefined,
    "Failed recovery replayed mutation",
  );
}
async function freshObservation(owner: HostPeer): Promise<void> {
  const nonce = crypto.randomUUID();
  const observed = await object(owner, "observeRetainedWorker", [nonce]);
  assert.equal(observed.nonce, nonce);
  assert.equal(observed.pathname, "/recovery-fs-worker.js");
  assert.equal(observed.matches, true);
}
async function lateRecovery(peers: CasePeers): Promise<void> {
  const { host } = peers;
  const owner = await peers.open("wait", "recovered");
  await waitProbe(host, owner, "probe-recovered");
  await invoke(owner, "beginDirectWrite", ["queued", "stale recovered mutation"]);
  assert.equal(
    (await object(owner, "directWrite", ["queued"])).status,
    "pending",
    "Queued write escaped load recovery gate",
  );
  const successor = await peers.open();
  await waitProbe(host, owner, "filesystem-ownership-lost");
  const before = await object(owner, "state", []);
  assert.ok(
    before.status === "opening" || before.status === "waiting",
    "Held ownership-loss reached page",
  );
  await invoke(owner, "releaseRecovery", []);
  await wait(
    host,
    owner,
    "window.lockTest.probes().includes('filesystem-error') || window.lockTest.probes().includes('filesystem-state:ready')",
  );
  const received = await probes(owner);
  assert.ok(
    !received.includes("filesystem-state:ready"),
    "Worker published recovered backend after ownership loss",
  );
  assert.ok(
    received.includes("probe-backend-disposed"),
    "Worker did not dispose recovered backend",
  );
  await waitState(host, owner, "failed");
  await invoke(owner, "beginDirectWrite", ["new", "new stale mutation"]);
  for (const label of ["queued", "new"] as const) await rejectedWrite(peers, owner, label);
  await invoke(owner, "releaseOwnershipLoss", []);
  await invoke(owner, "dispose", []);
  const resources = await object(owner, "resources", []);
  assert.equal(resources.terminations, 1);
  assert.equal(resources.clientDisposals, 1);
  await ready(host, successor, "late-recovery successor");
  assert.equal(
    await invoke(successor, "readQueued", []),
    undefined,
    "Late recovered backend replayed work",
  );
}
async function rejectedWrite(
  peers: CasePeers,
  owner: HostPeer,
  label: "queued" | "new",
): Promise<void> {
  await wait(
    peers.host,
    owner,
    `window.lockTest.directWrite(${JSON.stringify(label)}).status !== 'pending'`,
  );
  const result = await object(owner, "directWrite", [label]);
  assert.equal(result.status, "rejected");
  assert.equal(result.isError, true);
  assert.equal(typeof result.name, "string");
  assert.equal(typeof result.message, "string");
}
async function opfsRejected(peers: CasePeers): Promise<void> {
  const page = await peers.create();
  await invoke(page, "failWithOpfsTakeover", [peers.name]);
  await waitState(peers.host, page, "failed");
  const state = await object(page, "state", []);
  assert.equal(state.code, "INVALID_VFS_SETTINGS");
  assert.equal(state.vfs, "opfs-memory");
}
export function storageLockSchedule(
  peers: CasePeers,
  scenario: StorageLockScenario,
): Promise<void> {
  switch (scenario.kind) {
    case "contested":
    case "earlyReload":
    case "crashedOwner":
      return durable(peers, scenario.kind);
    case "cancelWhileWaiting":
      return cancel(peers);
    case "fifoWaiters":
      return fifo(peers);
    case "guestWork":
      return guest(peers);
    case "takeover":
      return takeover(peers, scenario.policy);
    case "opfsTakeoverRejected":
      return opfsRejected(peers);
    case "recovery":
      return recovery(peers, scenario.timing);
    case "lateRecoveryPublication":
      return lateRecovery(peers);
    default: {
      const exhaustive: never = scenario;
      throw new Error(String(exhaustive));
    }
  }
}
