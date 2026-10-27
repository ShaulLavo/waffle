import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";

await mkdir(".build/git-package", { recursive: true });
// npm pack runs the package's prepare hook, the sole Git/worker build in CI.
const result = spawnSync("npm", ["pack", "--pack-destination", ".build/git-package"], {
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`npm pack failed: ${result.status ?? result.signal}`);
