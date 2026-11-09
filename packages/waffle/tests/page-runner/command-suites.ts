import { checkNotificationResult, notificationSources } from "../notification-command.js";
import { resolve } from "node:path";
import { browserBundle } from "../browser-runner-lifecycle.js";
import { record, strings } from "./protocol.js";
import type { CollectorPolicy } from "./collector.js";
import type { SuiteAdapter } from "./suite-host.js";

export type CommandRequest = { entry: string; exportName: string; args: readonly string[] };
export type CommandDescriptor = CommandRequest & { id: string };
type Command = CommandRequest & {
  suite: "search-executor" | "fs-socket-attachment" | "guest-watch" | "notification";
  sources: Readonly<Record<string, string>>;
  caseMs: number;
  check(result: unknown): void;
};
const socketLabels = [
  "success/error owner replies survive sender handoff",
  "unreceived admitted scope retires root and transport on runtime shutdown",
  "late forwarded reply cannot revive scope or page guard",
];
export const commands = [
  {
    suite: "notification",
    entry: "/notification.js",
    exportName: "notificationCommand",
    args: [],
    sources: notificationSources,
    caseMs: 60_000,
    check: checkNotificationResult,
  },
  {
    suite: "search-executor",
    entry: "/tests.js",
    exportName: "searchExecutorBrowserCases",
    args: [],
    sources: {
      "/tests.js": "search-executor-browser.ts",
      "/search-worker.js": "fixtures/search-count-worker.ts",
      "/shard-worker.js": "../search/shard-worker.ts",
      "/fault-shard.js": "fixtures/search-fault-shard.ts",
      "/fs-worker.js": "../browser/fs-worker.ts",
    },
    caseMs: 600_000,
    check(result: unknown) {
      if (!record(result)) throw new Error("Search executor did not return a record");
    },
  },
  {
    suite: "fs-socket-attachment",
    entry: "/socket-attachment.js",
    exportName: "socketAttachmentCases",
    args: [],
    sources: {
      "/socket-attachment.js": "fs-socket-attachment-browser.ts",
      "/fs-worker.js": "../browser/fs-worker.ts",
    },
    caseMs: 60_000,
    check(result: unknown) {
      if (
        !Array.isArray(result) ||
        result.length !== socketLabels.length ||
        result.some((label, index) => label !== socketLabels[index])
      )
        throw new Error("Wrong filesystem socket attachment labels");
    },
  },
  {
    suite: "guest-watch",
    entry: "/guest-watch.js",
    exportName: "guestWatchCase",
    args: ["/guest.js", "/helper.js", "/writer.js"],
    sources: {
      "/guest-watch.js": "page-runner/guest-watch-command.ts",
      "/cases.js": "guest-watch-browser-cases.ts",
      "/race.js": "notification-race-cases.ts",
      "/guest.js": "fixtures/guest-watch-runtime-worker.ts",
      "/helper.js": "../browser/notification-worker.ts",
      "/writer.js": "fixtures/guest-watch-writer-worker.ts",
    },
    caseMs: 120_000,
    check(result: unknown) {
      if (!record(result) || !counter(result.early) || !counter(result.late))
        throw new Error("Guest watch requires nonnegative integer early and late counters");
      if (result.early + result.late !== 200) throw new Error("guest watch proof did not finish");
      if (!record(result.relay) || result.relay.iterations !== 200_000)
        throw new Error("notification relay proof did not finish");
    },
  },
] satisfies Command[];
function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function commandListIds(value: unknown): string[] {
  if (!record(value) || Object.keys(value).length !== 1 || !strings(value.ids))
    throw new Error("Invalid command list IDs");
  return value.ids;
}
export async function commandPageBundle(descriptor: CommandDescriptor): Promise<Blob> {
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "command-page.ts")],
    target: "browser",
    define: { PAGE_RUNNER_COMMAND: JSON.stringify(descriptor) },
  });
  if (!built.success || !built.outputs[0])
    throw new AggregateError(built.logs, "Command page bundle failed");
  return built.outputs[0];
}
export function commandAdapter(suite: Command["suite"]): SuiteAdapter<CommandRequest> {
  const command = commands.find((entry) => entry.suite === suite);
  if (!command) throw new Error(`Unknown command suite ${suite}`);
  const request: CommandRequest = {
    entry: command.entry,
    exportName: command.exportName,
    args: command.args,
  };
  const id = `${command.suite}: ${command.exportName}`;
  const policy: CollectorPolicy = {
    listIds: commandListIds,
    requireResult: true,
    check: (_id, result) => command.check(result),
  };
  return {
    suite,
    inventory: () => [{ id, label: command.exportName, request: () => request }],
    policy,
    async assets() {
      const assets: Record<string, Blob | string> = {
        "/page.js": await commandPageBundle({ ...request, id }),
      };
      for (const [path, source] of Object.entries(command.sources))
        assets[path] = await browserBundle(resolve(import.meta.dir, "..", source));
      return assets;
    },
    budgets: () => ({
      hello: 20_000,
      heartbeat: 10_000,
      case: command.caseMs,
      group: command.caseMs + 30_000,
      run: 3 * 90_000 + command.caseMs + 120_000,
    }),
  };
}
