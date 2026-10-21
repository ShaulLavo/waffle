import ts from "typescript";
import { readdir, readFile } from "node:fs/promises";
const directory = "tests/vfs-coordinator-proof";
const failures: string[] = [];
let maximum = 0;
function inspect(node: ts.Node, source: ts.SourceFile, depth: number): void {
  const next = depth + Number(ts.isBlock(node));
  maximum = Math.max(maximum, next);
  if (next > 3 && ts.isBlock(node)) {
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    failures.push(`${source.fileName}:${line}: block depth ${next}`);
  }
  ts.forEachChild(node, (child) => inspect(child, source, next));
}
for (const name of await readdir(directory)) {
  if (!name.endsWith(".ts")) continue;
  const path = `${directory}/${name}`;
  const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
  inspect(source, source, 0);
}
console.log(JSON.stringify({ kind: "SOURCE_DEPTH", maximum, failures }));
if (failures.length) process.exitCode = 1;
