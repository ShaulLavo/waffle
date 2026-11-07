import assert from "node:assert/strict";
import { join } from "node:path";
import { peerStorageControl } from "./peer-storage-controls.js";
import { runPageSuite, type SuiteAdapter } from "./suite-host.js";
import { PlaywrightDriver } from "./playwright-driver.js";
import type { HostCase, HostPeer } from "./protocol.js";

export const peerControlModes = [
  "peer-pass",
  "peer-four-live",
  "peer-root-target",
  "peer-close-no-dispose",
  "peer-reload",
  "peer-ack-held",
  "peer-ack-lost",
  "peer-unexpected-close",
  "peer-unexpected-reload",
  "peer-late-error",
  "peer-inactive-heartbeat",
  "peer-revoked",
  "peer-storage",
  "peer-assertion",
];
async function drive(
  host: HostCase,
  mode: string,
  retain: (peer: HostPeer) => void,
): Promise<unknown> {
  await host.script("window.__label = 'root';");
  const owner = await host.openPeer();
  await owner.script("window.__label = 'owner';");
  retain(owner);
  if (mode === "peer-close-no-dispose") return closeWithoutDispose(host, owner);
  if (mode === "peer-unexpected-reload") await owner.script("location.reload();");
  if (mode === "peer-unexpected-close") await owner.script("window.__triggerClose = true;");
  if (mode === "peer-late-error")
    await owner.script("setTimeout(() => { throw new Error('PEER_LATE_ERROR'); }, 20);");
  if (mode === "peer-inactive-heartbeat" || mode === "peer-late-error") await host.sleep(2500);
  if (mode === "peer-assertion") throw new Error("PEER_ASSERTION");
  const peers: HostPeer[] = [owner];
  if (mode === "peer-four-live") {
    for (let index = 1; index < 4; index++) peers.push(await host.openPeer());
  }
  for (let index = 0; index < peers.length; index++) {
    const peer = peers[index];
    assert.ok(peer);
    await peer.script(`window.__index = ${index};`);
  }
  for (let index = 0; index < peers.length; index++)
    assert.equal(await peers[index]?.script("return window.__index;"), index);
  assert.equal(await host.script("return window.__label;"), "root");
  if (mode === "peer-reload" || mode === "peer-ack-held") {
    const successor = await owner.reload();
    await assert.rejects(async () => owner.script("return true;"), /revoked|superseded/);
    assert.equal(await successor.script("return window.__label === undefined;"), true);
    await successor.close();
    peers.shift();
  }
  for (const peer of peers) await peer.close();
  return { peers: mode === "peer-four-live" ? 4 : 1, root: true };
}
export async function peerControl(
  engine: "chromium" | "webkit",
  mode: string,
  root: string,
): Promise<void> {
  if (mode === "peer-storage") return peerStorageControl(engine, root);
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "peer-control-page.ts")],
    target: "browser",
    define: { PEER_CONTROL: JSON.stringify(mode) },
  });
  if (!built.success || !built.outputs[0])
    throw new AggregateError(built.logs, "Peer control build");
  let retained: HostPeer | undefined, retainedHost: HostCase | undefined;
  let driver: PeerControlDriver | undefined;
  const adapter: SuiteAdapter<null> = {
    suite: "peer-control",
    inventory: () => [
      {
        id: "peer",
        label: "peer",
        request: () => null,
        drive: (host) => {
          retainedHost = host;
          return drive(host, mode, (peer) => {
            retained = peer;
          });
        },
      },
    ],
    assets: async () => ({ "/page.js": built.outputs[0] ?? "" }),
    policy: {
      listIds: (value) => {
        assert.deepEqual(value, ["peer"]);
        return ["peer"];
      },
      check() {},
    },
    budgets: () => ({
      hello: 4000,
      heartbeat: 2000,
      case: 20000,
      group: 25000,
      caseDocument: 25000,
      operation: 12000,
      run: 40000,
    }),
  };
  const result = await runPageSuite(
    adapter,
    (scratch) => (driver = new PeerControlDriver(engine, scratch, mode)),
    {
      resultPath: join(root, `${mode}.json`),
    },
  );
  assert.ok(driver);
  if (mode === "peer-ack-lost") assert.equal(driver.actions.length, 0);
  if (mode === "peer-ack-held") assert.deepEqual(driver.actions, ["create", "reload", "close"]);
  if (mode === "peer-revoked") {
    assert.ok(retained && retainedHost);
    await assert.rejects(
      async () => retained?.script("window.__forbidden=true;"),
      /revoked|closed|stopped/,
    );
    await assert.rejects(
      async () => retained?.task("window.__forbidden=true;"),
      /revoked|closed|stopped/,
    );
    await assert.rejects(async () => retained?.reload(), /revoked|closed|stopped/);
    await assert.rejects(async () => retainedHost?.openPeer(), /revoked|closed|stopped/);
  }
  const infrastructure = [
    "peer-ack-lost",
    "peer-unexpected-close",
    "peer-unexpected-reload",
    "peer-late-error",
    "peer-inactive-heartbeat",
  ].includes(mode);
  assert.equal(
    result.exit,
    infrastructure ? 2 : mode === "peer-assertion" ? 1 : 0,
    JSON.stringify(result),
  );
  if (infrastructure && mode !== "peer-ack-lost") {
    const peer = result.documents.find((state) => state.peer !== null && state.generation === 0);
    assert.ok(peer?.doc, "Fault has no original peer generation");
    assert.ok(
      result.failures.some(
        (failure) => failure.document?.doc === peer.doc && failure.document.generation === 0,
      ),
      JSON.stringify(result.failures),
    );
    assert.ok(
      !result.documents.some((state) => state.generation !== null && state.generation > 0),
      "Fault admitted a successor",
    );
  }
  assert.equal(result.cleanup.session.status, "confirmed");
  assert.equal(result.cleanup.scratch.status, "confirmed");
  if (!infrastructure) {
    assert.equal(result.runComplete, true);
    assert.ok(
      result.documents
        .filter((state) => state.peer)
        .every((state) => ["closed", "superseded"].includes(state.physical)),
    );
  }
}

async function closeWithoutDispose(host: HostCase, owner: HostPeer): Promise<unknown> {
  const key = crypto.randomUUID();
  await owner.script(
    `navigator.locks.request(${JSON.stringify(key)},()=>{window.__holding=true; return new Promise(()=>{});});`,
  );
  while (await owner.script("return window.__holding !== true;")) await host.sleep(10);
  const waiter = await host.openPeer();
  await waiter.script(
    `navigator.locks.request(${JSON.stringify(key)},()=>{window.__acquired=true;});`,
  );
  await waiter.task(
    `window.__pending=(await navigator.locks.query()).pending.some(lock=>lock.name===${JSON.stringify(key)});`,
  );
  assert.equal(await waiter.script("return window.__pending;"), true);
  await owner.close();
  while (await waiter.script("return window.__acquired !== true;")) await host.sleep(10);
  await waiter.close();
  return { nativeLockReleasedByExactClose: true };
}
class PeerControlDriver extends PlaywrightDriver {
  readonly actions: string[] = [];
  private async acknowledged(action: string, signal: AbortSignal): Promise<void> {
    if (this.mode === "peer-ack-held") {
      assert.equal(
        await super.script(
          "return window.__pageRunner.pending === 0 && window.__hostCase.transition.acknowledgedThrough === window.__pageRunner.ackedThrough;",
          signal,
        ),
        true,
        "Destructive action before actual HTTP ACK",
      );
    }
    this.actions.push(action);
  }
  override async createWindow(signal: AbortSignal): Promise<string> {
    await this.acknowledged("create", signal);
    return super.createWindow(signal);
  }
  override async reloadWindow(signal: AbortSignal): Promise<void> {
    await this.acknowledged("reload", signal);
    return super.reloadWindow(signal);
  }
  override async closeWindow(signal: AbortSignal): Promise<void> {
    await this.acknowledged("close", signal);
    return super.closeWindow(signal);
  }
  constructor(
    engine: "chromium" | "webkit",
    scratch: string,
    readonly mode: string,
  ) {
    super(engine, scratch);
  }
  override async script(source: string, signal: AbortSignal): Promise<unknown> {
    const result = await super.script(source, signal);
    if (this.mode === "peer-unexpected-close" && source.includes("window.__triggerClose = true;"))
      await super.closeWindow(signal);
    return result;
  }
}
