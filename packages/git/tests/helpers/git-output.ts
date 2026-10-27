import type { GitInvocation } from "../../src/git-types";

export async function captureGit(
  run: (invocation: GitInvocation) => Promise<number>,
  invocation: Pick<GitInvocation, "argv" | "cwd" | "env">,
) {
  const decoder = new TextDecoder();
  let stdout = "";
  let stderr = "";
  const status = await run({
    ...invocation,
    stdout(bytes) {
      stdout += decoder.decode(bytes);
    },
    stderr(bytes) {
      stderr += decoder.decode(bytes);
    },
  });
  return { status, stdout, stderr };
}
