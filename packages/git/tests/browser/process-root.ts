import type { Runtime } from "waffle";
import { createProgramTestRoot } from "../../../../tools/program-test-root.ts";
export type { TestExecution as Result } from "../../../../tools/program-test-root.ts";

export async function processRoot(runtime: Runtime, env: Readonly<Record<string, string>>) {
  const root = await createProgramTestRoot(runtime);
  return {
    spawn: (argv: readonly string[], cwd: string, executable = "/usr/bin/git") =>
      root.exec({
        executable,
        argv: [executable.slice(executable.lastIndexOf("/") + 1)].concat(argv),
        cwd,
        env: { ...env, PATH: "/usr/bin:/bin", HOME: "/home/user" },
      }),
    dispose: () => root.dispose(),
  };
}
