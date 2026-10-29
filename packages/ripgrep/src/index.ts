import type { SearchWorkers, SearchWorkerRequest } from "waffle/search";
import type { ProgramLaunch, ProgramPackage } from "waffle/programs";

export const ripgrep: ProgramPackage = {
  name: "ripgrep",
  programs: [
    {
      path: "/usr/bin/rg",
      aliases: ["/bin/rg"],
      wasm: new URL("../dist/rg.wasm", import.meta.url),
    },
  ],
};

export function fastRipgrep(
  workers: SearchWorkers,
  options: { readonly stdoutIsTTY?: boolean } = {},
): ProgramPackage {
  const launch: ProgramLaunch = async (context, service, fallback) => {
    if ((context.request.env.PWD || "/") !== context.request.cwd) return fallback(context, service);
    const { planRg } = await import("./plan.js");
    const admitted = planRg(context.request.argv.slice(1), context.request.env, options);
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
  return { ...ripgrep, programs: ripgrep.programs.map((program) => ({ ...program, launch })) };
}
