import { FilesystemError } from "../core/filesystem.js";

export type GlobPattern = { readonly kind: "basename" | "path"; readonly glob: string };
type Token =
  | { readonly kind: "star" | "deep" }
  | { readonly kind: "character"; readonly matches: (character: string) => boolean };
type Alternatives = readonly (readonly Token[])[];

export function compileGlob(pattern: GlobPattern): (path: string) => boolean {
  if (pattern.glob.length > 1024) throw new FilesystemError(28, "glob exceeds 1024 characters");
  const alternatives = new GlobParser(pattern.glob).parse();
  return (path) => {
    const name = pattern.kind === "basename" ? path.slice(path.lastIndexOf("/") + 1) : path;
    return alternatives.some((tokens) => match(tokens, name));
  };
}

function match(tokens: readonly Token[], path: string): boolean {
  let active = new Set([0]);
  skipStars(tokens, active);
  for (const character of path) {
    const next = new Set<number>();
    for (const index of active) advance(tokens, index, character, next);
    skipStars(tokens, next);
    if (!next.size) return false;
    active = next;
  }
  return active.has(tokens.length);
}
function advance(
  tokens: readonly Token[],
  index: number,
  character: string,
  next: Set<number>,
): void {
  const token = tokens[index];
  if (!token) return;
  if (token.kind === "deep" || (token.kind === "star" && character !== "/")) {
    next.add(index);
    return;
  }
  if (token.kind === "character" && token.matches(character)) next.add(index + 1);
}
function skipStars(tokens: readonly Token[], active: Set<number>): void {
  for (const index of active) {
    const token = tokens[index];
    if (token?.kind === "star" || token?.kind === "deep") active.add(index + 1);
  }
}
function literal(character: string): Token {
  return { kind: "character", matches: (value) => value === character };
}
function join(left: Alternatives, right: Alternatives): Alternatives {
  const count = left.length * right.length;
  const size =
    left.reduce((sum, tokens) => sum + tokens.length, 0) * right.length +
    right.reduce((sum, tokens) => sum + tokens.length, 0) * left.length;
  if (count > 128 || size > 4096) throw new FilesystemError(28, "glob alternatives exceed bound");
  return left.flatMap((first) => right.map((second) => first.concat(second)));
}
class GlobParser {
  private position = 0;
  constructor(private readonly source: string) {}
  parse(depth = 0): Alternatives {
    if (depth > 8) throw new FilesystemError(28, "glob braces exceed depth limit");
    let result: Alternatives = [[]];
    while (this.position < this.source.length) {
      const character = this.source[this.position++]!;
      if (depth && (character === "," || character === "}")) {
        this.position--;
        return result;
      }
      result = join(result, this.token(character, depth));
    }
    if (depth) throw new FilesystemError(28, "unclosed glob brace");
    return result;
  }
  private token(character: string, depth: number): Alternatives {
    if (character === "*") return this.star();
    if (character === "?") return [[{ kind: "character", matches: (value) => value !== "/" }]];
    if (character === "[") return [[this.characterClass()]];
    if (character === "{") return this.alternatives(depth + 1);
    if (character === "\\") {
      const escaped = this.source.codePointAt(this.position);
      if (escaped === undefined) throw new FilesystemError(28, "trailing glob escape");
      this.position += escaped > 0xffff ? 2 : 1;
      return [[literal(String.fromCodePoint(escaped))]];
    }
    if (character === "}") throw new FilesystemError(28, "unexpected glob brace");
    const point = this.source.codePointAt(this.position - 1)!;
    if (point > 0xffff) this.position++;
    return [[literal(String.fromCodePoint(point))]];
  }
  private star(): Alternatives {
    if (this.source[this.position] !== "*") return [[{ kind: "star" }]];
    while (this.source[this.position] === "*") this.position++;
    if (this.source[this.position] !== "/") return [[{ kind: "deep" }]];
    this.position++;
    return [[], [{ kind: "deep" }, literal("/")]];
  }
  private alternatives(depth: number): Alternatives {
    let parts: Alternatives = [];
    for (;;) {
      parts = parts.concat(this.parse(depth));
      if (parts.length > 128) throw new FilesystemError(28, "glob alternatives exceed bound");
      const delimiter = this.source[this.position++];
      if (delimiter === "}") return parts;
      if (delimiter !== ",") throw new FilesystemError(28, "unclosed glob brace");
    }
  }
  private characterClass(): Token {
    let content = "";
    if (this.source[this.position] === "!" || this.source[this.position] === "^") {
      content = "^";
      this.position++;
    }
    const start = this.position;
    while (this.position < this.source.length) {
      const character = this.source[this.position++]!;
      if (character === "]" && this.position > start + 1) return classToken(content);
      if (character === "/") throw new FilesystemError(28, "slash in glob class");
      if (character === "\\") {
        const escaped = this.source[this.position++];
        if (escaped === undefined || escaped === "/")
          throw new FilesystemError(28, "invalid glob class escape");
        content += escaped.replace(/[\\\]^-]/g, "\\$&");
        continue;
      }
      content +=
        character === "\\" || character === "[" || character === "]" ? `\\${character}` : character;
    }
    throw new FilesystemError(28, "unclosed glob class");
  }
}
function classToken(content: string): Token {
  try {
    const expression = new RegExp(`^[${content}]$`, "u");
    return { kind: "character", matches: (value) => value !== "/" && expression.test(value) };
  } catch {
    throw new FilesystemError(28, "invalid glob class");
  }
}
