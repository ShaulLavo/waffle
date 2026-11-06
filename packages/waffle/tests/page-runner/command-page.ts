import { startPage } from "./page-main.js";
import type { CommandDescriptor, CommandRequest } from "./command-suites.js";

declare const PAGE_RUNNER_COMMAND: CommandDescriptor;
async function exported(request: CommandRequest): Promise<(...args: string[]) => unknown> {
  const module: Record<string, unknown> = await import(request.entry);
  const entry = module[request.exportName];
  if (typeof entry !== "function") throw new Error(`Missing command export ${request.exportName}`);
  return (...args) => entry(...args);
}
startPage<CommandRequest>({
  async list() {
    await exported(PAGE_RUNNER_COMMAND);
    return { ids: [PAGE_RUNNER_COMMAND.id] };
  },
  async run(request) {
    const entry = await exported(request);
    return await entry(...request.args.map((path) => new URL(path, location.href).href));
  },
  finish: (ledger) => Promise.resolve(ledger.slice()),
});
