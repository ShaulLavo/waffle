import { join } from "node:path";
import { runPageSuite, type SuiteAdapter } from "waffle/testing/page-runner";
import { PlaywrightDriver } from "waffle/testing/page-runner/playwright";

const root = process.argv[2];
if (!root) throw new Error("Missing signal control scratch");
const released = Promise.withResolvers<void>();
process.stdin.once("data", () => released.resolve());
let active = 0,
  closes = 0;
let listener: Bun.TCPSocketListener<undefined> | undefined;
let client: Bun.Socket<undefined> | undefined;
const sockets = new Set<Bun.Socket<undefined>>();
const adapter: SuiteAdapter<null> = {
  suite: "network-signal-control",
  inventory: () => [{ id: "signal", label: "pending callback", request: () => null }],
  budgets: () => ({ hello: 5000, heartbeat: 5000, case: 20_000, group: 25_000, run: 30_000 }),
  policy: { listIds: () => ["signal"], check() {} },
  assets: async () => ({
    "/page.js": `import {startPage,cleanupStorage} from '/bootstrap.js'; startPage({list:async()=>({ids:['signal']}),run:async(_r,_a,c)=>(await c.fetchFixture('/idle')).json(),finish:cleanupStorage});`,
    "/bootstrap.js": await bootstrap(),
  }),
  fixture: {
    caseId: "signal",
    create: () => ({
      async start() {
        listener = Bun.listen<undefined>({
          hostname: "127.0.0.1",
          port: 0,
          socket: {
            open(socket) {
              sockets.add(socket);
            },
            data() {},
            close(socket) {
              sockets.delete(socket);
            },
          },
        });
        client = await Bun.connect<undefined>({
          hostname: "127.0.0.1",
          port: listener.port,
          socket: { data() {} },
        });
        return [
          {
            path: "/idle",
            async get({ signal }) {
              active++;
              try {
                if (!sockets.size) throw new Error("Real socket was not held");
                console.log("callback-entered");
                await new Promise<void>((resolve) =>
                  signal.aborted
                    ? resolve()
                    : signal.addEventListener("abort", () => resolve(), { once: true }),
                );
                console.log("callback-aborted");
                await released.promise;
                console.log("callback-joined");
                throw new Error("Actual callback cancelled");
              } finally {
                active--;
              }
            },
          },
        ];
      },
      async close() {
        if (active || ++closes !== 1)
          throw new Error("Close before callback join or duplicate close");
        client?.end();
        for (const socket of sockets) socket.end();
        listener?.stop(true);
        console.log("fixture-closed");
      },
    }),
  },
};
async function bootstrap(): Promise<Blob> {
  const built = await Bun.build({
    entrypoints: [new URL("./page-runner/consumer-page.ts", import.meta.url).pathname],
    target: "browser",
  });
  if (!built.success || !built.outputs[0]) throw new AggregateError(built.logs);
  return built.outputs[0];
}
const result = await runPageSuite(adapter, (scratch) => new PlaywrightDriver("chromium", scratch), {
  resultPath: join(root, "result.json"),
  scratchRoot: root,
  port: "ephemeral",
});
if (
  result.exit === 0 ||
  result.cleanup.callbacks.status !== "confirmed" ||
  result.cleanup.fixture.status !== "confirmed" ||
  closes !== 1
)
  throw new Error("Signal cleanup was not truthful");
console.log("result-saved");
process.exitCode = result.exit;
