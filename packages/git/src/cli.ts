import { runGit } from "./git-command";
import { nodeGitFilesystem } from "./node-filesystem";

/** The `git` program: the same backend as `installGit`, driven by process argv/cwd/env/stdio. */
const writer = (stream: NodeJS.WriteStream) => (bytes: Uint8Array) =>
  new Promise<void>((resolve, reject) =>
    stream.write(bytes, (error) => (error ? reject(error) : resolve())),
  );
const env: Record<string, string> = {};
for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
process.exitCode = await runGit(nodeGitFilesystem, {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env,
  stdout: writer(process.stdout),
  stderr: writer(process.stderr),
});
