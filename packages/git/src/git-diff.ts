import * as git from "isomorphic-git";
import { structuredPatch } from "diff";
import { options, output, pathspec, selected, type GitContext } from "./git-context";

export async function gitDiff(context: GitContext, args: readonly string[]) {
  const parsed = options(args, [
    "--cached",
    "--staged",
    "--name-only",
    "--no-prefix",
    "--no-color",
    "--no-ext-diff",
    "--exit-code",
    "--quiet",
  ]);
  const specs = parsed.paths.map((path) => pathspec(context, path));
  const cached = parsed.flags.has("--cached") || parsed.flags.has("--staged");
  const patches: { path: string; text: string }[] = [];
  await git.walk({
    ...context,
    trees: cached ? [git.TREE({ ref: "HEAD" }), git.STAGE()] : [git.STAGE(), git.WORKDIR()],
    async map(path, entries) {
      const [before, after] = entries;
      if (path === "." || !selected(path, specs)) return;
      if ((await before?.type()) === "tree" || (await after?.type()) === "tree") return;
      if (!cached && !before) return;
      const oldOid = await before?.oid();
      const newOid = await after?.oid();
      if (oldOid === newOid) return;
      const patch = parsed.flags.has("--name-only")
        ? `${path}\n`
        : await patchFor(context, path, before, after, parsed.flags.has("--no-prefix"));
      patches.push({ path, text: patch });
    },
  });
  patches.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (!parsed.flags.has("--quiet"))
    await output(context, patches.map((patch) => patch.text).join(""));
  return patches.length && (parsed.flags.has("--exit-code") || parsed.flags.has("--quiet")) ? 1 : 0;
}

type WalkerEntry = Parameters<NonNullable<Parameters<typeof git.walk>[0]["map"]>>[1][number];

async function patchFor(
  context: GitContext,
  path: string,
  before: WalkerEntry,
  after: WalkerEntry,
  noPrefix: boolean,
) {
  const oldBytes = await content(context, before);
  const newBytes = await content(context, after);
  const oldOid = ((await before?.oid()) ?? "0000000").slice(0, 7);
  const newOid = ((await after?.oid()) ?? "0000000").slice(0, 7);
  const oldPath = `${noPrefix ? "" : "a/"}${path}`;
  const newPath = `${noPrefix ? "" : "b/"}${path}`;
  const headers = [`diff --git ${oldPath} ${newPath}`];
  if (!before) headers.push("new file mode 100644");
  if (!after) headers.push("deleted file mode 100644");
  headers.push(`index ${oldOid}..${newOid}${before && after ? " 100644" : ""}`);
  if (oldBytes.includes(0) || newBytes.includes(0))
    return headers
      .concat([
        `Binary files ${before ? oldPath : "/dev/null"} and ${after ? newPath : "/dev/null"} differ`,
        "",
      ])
      .join("\n");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const patch = structuredPatch(
    oldPath,
    newPath,
    decoder.decode(oldBytes),
    decoder.decode(newBytes),
    undefined,
    undefined,
    { context: 3 },
  );
  headers.push(
    `--- ${before ? headerPath(oldPath) : "/dev/null"}`,
    `+++ ${after ? headerPath(newPath) : "/dev/null"}`,
  );
  return headers
    .concat(
      patch.hunks.flatMap((hunk) =>
        [
          `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`,
        ].concat(hunk.lines),
      ),
      [""],
    )
    .join("\n");
}

async function content(context: GitContext, entry: WalkerEntry) {
  if (!entry) return new Uint8Array();
  const bytes = await entry.content();
  if (bytes) return bytes;
  const oid = await entry.oid();
  if (!oid) return new Uint8Array();
  return (await git.readBlob({ ...context, oid })).blob;
}

function headerPath(path: string) {
  return path.includes(" ") ? `${path}\t` : path;
}

function range(start: number, length: number) {
  if (length === 0) return `${start - 1},0`;
  return length === 1 ? String(start) : `${start},${length}`;
}
