import {
  runPageSuite,
  type SuiteAdapter,
  type SuiteFixture,
  type FixtureRequest,
} from "waffle/testing/page-runner";
import { PlaywrightDriver } from "waffle/testing/page-runner/playwright";
import { browserBundle } from "../browser-runner-lifecycle.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm, stat } from "node:fs/promises";
export const fixtureControlModes = [
  "socket-idle",
  "cancel-join",
  "noncooperative",
  "serialize-cancel",
  "startup-failure",
  "close-failure",
];
function assert(value: unknown, detail: string): asserts value {
  if (!value) throw new Error(detail);
}
class SocketFixture implements SuiteFixture {
  readonly entered = Promise.withResolvers<void>();
  readonly ended = Promise.withResolvers<void>();
  readonly closed = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();
  readonly sockets = new Set<Bun.Socket<undefined>>();
  listener: Bun.TCPSocketListener<undefined> | undefined;
  client: Bun.Socket<undefined> | undefined;
  active = 0;
  closeCalls = 0;
  scratch = "";
  constructor(
    readonly mode: string,
    readonly controller: AbortController,
  ) {}
  async start({ origin, signal, scratch }: Parameters<SuiteFixture["start"]>[0]) {
    this.scratch = scratch;
    signal.throwIfAborted();
    this.listener = Bun.listen<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (socket) => {
          this.sockets.add(socket);
        },
        data() {},
        close: (socket) => {
          this.sockets.delete(socket);
          if (!this.sockets.size) this.ended.resolve();
        },
      },
    });
    this.client = await Bun.connect<undefined>({
      hostname: "127.0.0.1",
      port: this.listener.port,
      socket: { data() {} },
    });
    signal.throwIfAborted();
    if (this.mode === "startup-failure") throw new Error("CONTROL_START_FAILURE");
    return [
      { path: "/config", get: async () => ({ origin }) },
      { path: "/idle", get: ({ signal }: FixtureRequest) => this.idle(signal) },
    ];
  }
  private async idle(signal: AbortSignal): Promise<unknown> {
    this.active++;
    this.entered.resolve();
    try {
      if (this.mode === "noncooperative") await this.release.promise;
      else await this.waitForSockets(signal);
      if (this.sockets.size) throw new Error("Actual held sockets remain");
      const count = this.sockets.size;
      if (this.mode === "serialize-cancel")
        return {
          toJSON: () => {
            this.controller.abort("during serialization");
            return { sockets: count };
          },
        };
      return { sockets: count };
    } finally {
      this.active--;
    }
  }
  private async waitForSockets(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.sockets.size) return;
    const aborted = Promise.withResolvers<never>();
    const abort = () => aborted.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      await Promise.race([this.ended.promise, aborted.promise]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  releaseSockets(): void {
    this.client?.end();
    for (const socket of this.sockets) socket.end();
  }
  async close(): Promise<void> {
    this.closeCalls++;
    assert(this.active === 0, "Fixture closed while callback still read its state");
    this.releaseSockets();
    this.listener?.stop(true);
    if (this.sockets.size) await this.ended.promise;
    this.closed.resolve();
    if (this.mode === "close-failure") throw new Error("CONTROL_CLOSE_FAILURE");
  }
}
export async function fixtureCapabilityControl(
  engine: "chromium" | "webkit",
  mode: string,
  root: string,
): Promise<void> {
  const controller = new AbortController();
  const original = new SocketFixture(mode, controller);
  let created = 0;
  const a: SuiteAdapter<null> = {
    suite: "fixture-capability",
    inventory: () => [{ id: "fixture", label: mode, request: () => null }],
    fixture: {
      caseId: "fixture",
      create: () => {
        created++;
        return original;
      },
    },
    assets: async () => ({
      "/page.js": await browserBundle(join(import.meta.dir, "fixture-capability-control-page.ts")),
    }),
    policy: { listIds: () => ["fixture"], check() {} },
    budgets: () => ({ hello: 5000, heartbeat: 5000, case: 10_000, group: 15_000, run: 25_000 }),
  };
  const running = runPageSuite(a, (scratch) => new PlaywrightDriver(engine, scratch), {
    scratchRoot: process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(),
    resultPath: join(root, `fixture-${engine}-${mode}.json`),
    signal: controller.signal,
    port: "ephemeral",
    cleanupTimeoutMs: mode === "noncooperative" ? 1000 : undefined,
  });
  try {
    if (mode !== "startup-failure") {
      await Promise.race([
        original.entered.promise,
        running.then((result) => {
          throw new Error(`Fixture never entered: ${JSON.stringify(result.failures)}`);
        }),
      ]);
      assert(original.sockets.size > 0, "Idle callback did not observe held real sockets");
      if (mode === "cancel-join" || mode === "noncooperative")
        controller.abort("cancel real idle observer");
      else original.releaseSockets();
    }
    const result = await running;
    assert(created === 1, "Fixture was replaced or constructed twice");
    assert(
      mode === "socket-idle" ? result.exit === 0 : result.exit !== 0,
      `Unexpected fixture ${mode} outcome: ${JSON.stringify(result)}`,
    );
    if (mode === "noncooperative") {
      assert(
        original.closeCalls === 0 &&
          result.cleanup.callbacks.status === "unconfirmed" &&
          result.cleanup.fixture.status === "unconfirmed" &&
          result.cleanup.scratch.status === "unconfirmed",
        "Noncooperative work was declared contained",
      );
      assert((await stat(original.scratch)).isDirectory(), "Unjoined scratch was removed");
      const frozen = JSON.stringify(result);
      original.releaseSockets();
      await original.ended.promise;
      original.release.resolve();
      await original.closed.promise;
      assert(JSON.stringify(result) === frozen, "Late callback changed failed result");
    } else
      assert(result.cleanup.callbacks.status === "confirmed", "Actual idle callback did not join");
    assert(original.closeCalls === 1, "Expected exactly one real fixture close");
  } finally {
    controller.abort("control teardown");
    original.releaseSockets();
    original.release.resolve();
    await running;
    if (created) await original.closed.promise;
    if (original.scratch) await rm(original.scratch, { recursive: true, force: true });
  }
}
