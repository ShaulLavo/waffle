import type { SearchWorkers, SearchWorkerRequest } from "waffle/search";
import type { ProgramLaunch, ProgramPackage } from "waffle/programs";

export const grep: ProgramPackage = {
  name: "grep",
  programs: [
    {
      path: "/usr/bin/grep",
      aliases: ["/bin/grep"],
      wasm: new URL("../dist/grep.wasm", import.meta.url),
    },
  ],
};

export function fastGrep(workers: SearchWorkers): ProgramPackage {
  const launch: ProgramLaunch = async (context, service, fallback) => {
    const { planGrep } = await import("./plan.js");
    const admitted = planGrep(context.request.argv.slice(1), context.request.env);
    if (admitted.kind === "fallback") return fallback(context, service);
    return service.launchWorker<SearchWorkerRequest>(context, {
      workerUrl: workers.search,
      request: {
        module: context.module,
        args: context.request.argv,
        env: context.request.env,
        interruptible: context.interruptible,
        plan: admitted.plan,
        search: { shardWorker: workers.shard, shards: null, diagnostics: false },
      },
    });
  };
  return { ...grep, programs: grep.programs.map((program) => ({ ...program, launch })) };
}
