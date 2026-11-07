import assert from "node:assert/strict";
import { join } from "node:path";
import { browserBundle } from "../browser-runner-lifecycle.js";
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
async function drive(host: HostCase, mode: string): Promise<unknown> {
  await host.script("window.__label = 'root';");
  const owner = await host.openPeer();
  await owner.script("window.__label = 'owner';");
  if (mode === "peer-unexpected-reload") await owner.script("location.reload();");
  if (mode === "peer-unexpected-close") await owner.script("window.close();");
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
  if (mode === "peer-reload") {
    const successor = await owner.reload();
    await assert.rejects(() => owner.script("return true;"), /revoked|superseded/);
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
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "peer-control-page.ts")],
    target: "browser",
    define: { PEER_CONTROL: JSON.stringify(mode) },
  });
  if (!built.success || !built.outputs[0])
    throw new AggregateError(built.logs, "Peer control build");
  const adapter: SuiteAdapter<null> = {
    suite: "peer-control",
    inventory: () => [
      { id: "peer", label: "peer", request: () => null, drive: (host) => drive(host, mode) },
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
  const result = await runPageSuite(adapter, (scratch) => new PlaywrightDriver(engine, scratch), {
    resultPath: join(root, `${mode}.json`),
  });
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
