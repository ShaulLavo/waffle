import * as git from "isomorphic-git";
import type { GitFilesystem } from "../../src/git-types";

export async function gitBlob(fs: GitFilesystem, dir: string, ref: "HEAD" | "INDEX", path: string) {
  let value: string | null = null;
  await git.walk({
    fs,
    dir,
    trees: [ref === "INDEX" ? git.STAGE() : git.TREE({ ref })],
    async map(filepath, [entry]) {
      if (filepath !== path || !entry || (await entry.type()) !== "blob") return;
      const { blob } = await git.readBlob({ fs, dir, oid: await entry.oid() });
      value = new TextDecoder().decode(blob);
    },
  });
  return value;
}
