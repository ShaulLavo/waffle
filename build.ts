// Source-first package: emit one Node module per source, preserving shared state.
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "acorn";

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

/** Rewrite syntax nodes only: an ordinary string/comment/regex is never an import. */
export function rewriteNodeImports(code: string, source: string, root: string): string {
  const parsed = parse(code, { ecmaVersion: "latest", sourceType: "module" });
  const edits: { start: number; end: number; text: string }[] = [];
  type Node = { type: string; start: number; end: number; value?: unknown; source?: Node; [key: string]: unknown };
  function imported(node: Node): void {
    if (typeof node.value !== "string" || !node.value.startsWith(".")) return;
    const specifier = node.value;
    const base = resolve(dirname(source), specifier);
    if (!inside(root, base)) throw new Error(`Import outside package: ${specifier} in ${source}`);
    const candidates = /\.(?:ts|js)$/.test(base)
      ? [base.replace(/\.js$/, ".ts"), base]
      : [base + ".ts", base + ".js", join(base, "index.ts"), join(base, "index.js")];
    const target = candidates.find(existsSync);
    if (!target) throw new Error(`Cannot resolve ${specifier} in ${source}`);
    let output = relative(dirname(source), target).replace(/\.ts$/, ".js").replaceAll("\\", "/");
    if (!output.startsWith(".")) output = "./" + output;
    edits.push({ start: node.start, end: node.end, text: JSON.stringify(output) });
  }
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const child of value) visit(child); return; }
    const node = value as Node;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(node.type) && node.source) imported(node.source);
    for (const child of Object.values(node)) visit(child);
  }
  visit(parsed);
  edits.sort((a, b) => b.start - a.start);
  for (const edit of edits) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  return code;
}

export async function buildNodeModules(root = import.meta.dir): Promise<void> {
  const outdir = join(root, "dist");
  rmSync(outdir, { recursive: true, force: true });
  const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
  async function emit(path: string): Promise<void> {
    if (!/\.(?:ts|js)$/.test(path) || path.endsWith(".d.ts")) return;
    const source = join(root, path);
    let code = await Bun.file(source).text();
    if (path.endsWith(".ts")) code = transpiler.transformSync(code);
    code = rewriteNodeImports(code, source, root);
    const output = join(outdir, path.replace(/\.ts$/, ".js"));
    mkdirSync(dirname(output), { recursive: true });
    await Bun.write(output, code);
  }
  async function visit(directory: string): Promise<void> {
    if (!existsSync(join(root, directory))) return;
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else await emit(path);
    }
  }
  for (const directory of ["core", "fs", "proc", "interrupt", "browser"]) await visit(directory);
  for (const file of ["index.ts", "runtime.ts"]) if (existsSync(join(root, file))) await emit(file);
}

if (import.meta.main) await buildNodeModules();
