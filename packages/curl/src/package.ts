import { defineProgramPackage } from "waffle/programs/catalog";
import { createCurlCommand, curlPaths } from "./command.ts";
import type { CurlPackageOptions } from "./host-command.ts";

/** Optional trusted command. The application supplies its transport and any file authority. */
export function createCurlPackage(options: CurlPackageOptions) {
  const { fetch, files, timeoutMs } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647)
    throw new TypeError("curl requires a finite positive overall deadline");
  const command = createCurlCommand();
  return defineProgramPackage({
    name: "curl",
    programs: [
      {
        path: curlPaths[0],
        aliases: curlPaths.slice(1),
        command: {
          load: async () => {
            const { bindCurlCommand } = await import("./host-command.ts");
            return bindCurlCommand(command, { fetch, files, timeoutMs });
          },
        },
      },
    ],
    dispose: command.dispose,
  });
}
