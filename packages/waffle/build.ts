// Source-first package: emit one Node module per source, preserving shared state.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { buildNetwork } from "./tooling/build-network";

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

type StringLiteral = { start: number; end: number; value: string };

function decodeString(source: string, start: number, quote: string): StringLiteral {
  let value = "";
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index]!;
    if (character === quote) return { start, end: index + 1, value };
    if (character !== "\\") {
      value += character;
      continue;
    }
    const escaped = source[++index];
    if (escaped === undefined) break;
    const simple: Record<string, string> = {
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "0": "\0",
    };
    if (simple[escaped] !== undefined) {
      value += simple[escaped];
      continue;
    }
    if (escaped === "x") {
      const hex = source.slice(index + 1, index + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 2;
        continue;
      }
    }
    if (escaped === "u") {
      const hex =
        source[index + 1] === "{"
          ? source.slice(index + 2, source.indexOf("}", index + 2))
          : source.slice(index + 1, index + 5);
      if (/^[0-9a-fA-F]+$/.test(hex)) {
        value += String.fromCodePoint(Number.parseInt(hex, 16));
        index += source[index + 1] === "{" ? hex.length + 2 : 4;
        continue;
      }
    }
    value += escaped;
  }
  throw new SyntaxError(`Unterminated string literal at ${start}`);
}

function skipComment(code: string, index: number): number {
  if (code[index] !== "/") return index;
  if (code[index + 1] === "/") {
    const end = code.indexOf("\n", index + 2);
    return end < 0 ? code.length : end;
  }
  if (code[index + 1] === "*") {
    const end = code.indexOf("*/", index + 2);
    if (end < 0) throw new SyntaxError(`Unterminated comment at ${index}`);
    return end + 2;
  }
  return index;
}

function skipTemplate(code: string, index: number): number {
  for (let at = index + 1; at < code.length; at++) {
    if (code[at] === "\\") {
      at++;
      continue;
    }
    if (code[at] === "`") return at + 1;
  }
  throw new SyntaxError(`Unterminated template literal at ${index}`);
}

function skipRegex(code: string, index: number): number {
  for (let at = index + 1; at < code.length; at++) {
    if (code[at] === "\\") {
      at++;
      continue;
    }
    if (code[at] === "[") {
      for (at++; at < code.length && code[at] !== "]"; at++) if (code[at] === "\\") at++;
      continue;
    }
    if (code[at] === "/") {
      at++;
      while (/[A-Za-z]/.test(code[at] ?? "")) at++;
      return at;
    }
    if (code[at] === "\n") return index;
  }
  return code.length;
}

function trivia(code: string, index: number): number {
  for (;;) {
    while (/\s/.test(code[index] ?? "")) index++;
    const next = skipComment(code, index);
    if (next === index) return index;
    index = next;
  }
}

function identifier(code: string, index: number): { value: string; end: number } | undefined {
  if (!/[A-Za-z_$]/.test(code[index] ?? "")) return undefined;
  let end = index + 1;
  while (/[A-Za-z0-9_$]/.test(code[end] ?? "")) end++;
  return { value: code.slice(index, end), end };
}

function nextString(code: string, index: number): StringLiteral | undefined {
  index = trivia(code, index);
  const quote = code[index];
  return quote === '"' || quote === "'" ? decodeString(code, index, quote) : undefined;
}

function fromSpecifier(code: string, at: number): StringLiteral | undefined {
  while (at < code.length && code[at] !== ";") {
    const quote = code[at];
    if (quote === '"' || quote === "'") {
      at = decodeString(code, at, quote).end;
      continue;
    }
    const commentEnd = skipComment(code, at);
    if (commentEnd !== at) {
      at = commentEnd;
      continue;
    }
    const word = identifier(code, at);
    const literal = word?.value === "from" ? nextString(code, word.end) : undefined;
    if (literal) return literal;
    at = word ? word.end : at + 1;
  }
  return undefined;
}

function moduleSpecifier(
  code: string,
  token: { value: string; end: number },
  index: number,
): StringLiteral | undefined {
  const after = trivia(code, token.end);
  if (token.value === "import" && !code.slice(0, index).trimEnd().endsWith(".")) {
    if (code[after] === "(") return nextString(code, after + 1);
    return nextString(code, after) ?? fromSpecifier(code, after);
  }
  if (token.value === "export" && (code[after] === "{" || code[after] === "*")) {
    return fromSpecifier(code, after + 1);
  }
  return undefined;
}

/** Rewrite relative module specifiers without treating strings, comments or regexes as imports. */
export function rewriteNodeImports(code: string, source: string, root: string): string {
  const edits: StringLiteral[] = [];
  let index = 0;
  let canStartRegex = true;
  while (index < code.length) {
    const character = code[index]!;
    if (/\s/.test(character)) {
      index++;
      continue;
    }
    const commentEnd = skipComment(code, index);
    if (commentEnd !== index) {
      index = commentEnd;
      continue;
    }
    if (character === '"' || character === "'") {
      index = decodeString(code, index, character).end;
      canStartRegex = false;
      continue;
    }
    if (character === "`") {
      index = skipTemplate(code, index);
      canStartRegex = false;
      continue;
    }
    if (character === "/" && canStartRegex && code[index + 1] !== "/" && code[index + 1] !== "*") {
      const regexEnd = skipRegex(code, index);
      if (regexEnd !== index) {
        index = regexEnd;
        canStartRegex = false;
        continue;
      }
    }
    const token = identifier(code, index);
    if (token) {
      const literal = moduleSpecifier(code, token, index);
      if (literal?.value.startsWith(".")) edits.push(literal);
      canStartRegex = [
        "return",
        "throw",
        "case",
        "delete",
        "void",
        "typeof",
        "new",
        "in",
        "of",
        "instanceof",
        "yield",
        "await",
      ].includes(token.value);
      index = token.end;
      continue;
    }
    canStartRegex = "([{,:;!?=+*%&|^~<>-".includes(character);
    index++;
  }
  const expected = new Bun.Transpiler({ loader: "ts" })
    .scanImports(code)
    .map((entry) => entry.path)
    .filter((path) => path.startsWith("."));
  const actual = edits.map((literal) => literal.value);
  if (expected.length !== actual.length || expected.some((path, index) => path !== actual[index])) {
    throw new Error(`Bun import scanner disagrees with Waffle's syntax scanner in ${source}`);
  }
  const resolved = edits.map((literal) => {
    const specifier = literal.value;
    const base = resolve(dirname(source), specifier);
    if (!inside(root, base)) throw new Error(`Import outside package: ${specifier} in ${source}`);
    const candidates = /\.(?:ts|js)$/.test(base)
      ? [base.replace(/\.js$/, ".ts"), base]
      : [base + ".ts", base + ".js", join(base, "index.ts"), join(base, "index.js")];
    const target = candidates.find(existsSync);
    if (!target) throw new Error(`Cannot resolve ${specifier} in ${source}`);
    let output = relative(dirname(source), target).replace(/\.ts$/, ".js").replaceAll("\\", "/");
    if (!output.startsWith(".")) output = "./" + output;
    return { start: literal.start, end: literal.end, text: JSON.stringify(output) };
  });
  resolved.sort((a, b) => b.start - a.start);
  for (const edit of resolved) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  return code;
}

export async function buildNodeModules(
  root = import.meta.dir,
  prepareNetwork = buildNetwork,
): Promise<void> {
  await prepareNetwork(root);
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
  for (const directory of [
    "core",
    "fs",
    "proc",
    "interrupt",
    "browser",
    "group",
    "link",
    "search",
    "programs",
  ])
    await visit(directory);
  for (const file of ["index.ts", "runtime.ts"]) if (existsSync(join(root, file))) await emit(file);
  copyFileSync(join(root, "browser/net/network.wasm"), join(outdir, "browser/net/network.wasm"));
}

if (import.meta.main) await buildNodeModules();
