import { CommandError, unsupported } from "./model.ts";

interface Atom {
  readonly accepts: (character: string) => boolean;
  readonly min: 0 | 1;
  readonly repeat: boolean;
}
export interface Pattern {
  test(text: string): boolean;
}

// A bounded dynamic program, not the host engine's backtracking RegExp executor.
export function compilePattern(source: string, exact: boolean, ignoreCase: boolean): Pattern {
  if (source.length > 512) unsupported("patterns longer than 512 characters are not supported");
  if (/[^\x20-\x7e]/.test(source)) unsupported("only ASCII patterns are supported");
  const start = exact || source.startsWith("^");
  const anchoredEnd = trailingAnchor(source);
  const end = exact || anchoredEnd;
  const body = source.slice(source.startsWith("^") ? 1 : 0, anchoredEnd ? -1 : undefined);
  const atoms = parseAtoms(ignoreCase ? body.toLowerCase() : body);
  return { test: (text) => matches(atoms, ignoreCase ? foldAscii(text) : text, start, end) };
}

function trailingAnchor(source: string): boolean {
  if (!source.endsWith("$")) return false;
  let slashes = 0;
  for (let index = source.length - 2; index >= 0 && source[index] === "\\"; index--) slashes++;
  return slashes % 2 === 0;
}

function parseAtoms(source: string): Atom[] {
  const atoms: Atom[] = [];
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if ("*+?".includes(character)) {
      atoms.push(quantify(atoms.pop(), character));
      continue;
    }
    if ("()|{}^$".includes(character))
      unsupported("groups, alternation, braces, and internal anchors are not supported");
    if (character === "[") {
      const parsed = characterClass(source, index);
      atoms.push({ accepts: parsed.accepts, min: 1, repeat: false });
      index = parsed.end;
      continue;
    }
    const literal = character === "\\" ? source[++index] : character;
    if (literal === undefined) invalid();
    if (character === "\\" && /[a-z0-9]/i.test(literal))
      unsupported("escaped letters and backreferences are not supported");
    atoms.push({
      accepts: character === "." ? () => true : (value) => value === literal,
      min: 1,
      repeat: false,
    });
  }
  return atoms;
}

function characterClass(source: string, start: number) {
  const end = source.indexOf("]", start + 1);
  if (end < 0) invalid();
  let body = source.slice(start + 1, end);
  const negate = body.startsWith("^");
  if (negate) body = body.slice(1);
  if (!body) invalid();
  if (body.includes("[") || body.includes("\\"))
    unsupported("POSIX named classes and escaped class characters are not supported");
  const ranges: Array<readonly [string, string]> = [];
  for (let index = 0; index < body.length; index++) {
    const first = body[index]!;
    const last =
      body[index + 1] === "-" && body[index + 2] !== undefined ? body[(index += 2)]! : first;
    if (first > last) invalid();
    ranges.push([first, last]);
  }
  return {
    end,
    accepts: (value: string) =>
      ranges.some(([first, last]) => value >= first && value <= last) !== negate,
  };
}

function matches(atoms: readonly Atom[], text: string, start: boolean, end: boolean): boolean {
  let positions = new Uint8Array(text.length + 1);
  if (start) positions[0] = 1;
  else positions.fill(1);
  let next = new Uint8Array(positions.length);
  for (const atom of atoms) {
    if (atom.min === 0) next.set(positions);
    else next.fill(0);
    advance(atom, positions, next, text);
    const previous = positions;
    positions = next;
    next = previous;
  }
  return end ? positions[text.length] === 1 : positions.includes(1);
}

function invalid(): never {
  throw new CommandError("regex error: Invalid regular expression");
}

function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function quantify(previous: Atom | undefined, character: string): Atom {
  if (!previous || previous.repeat || previous.min === 0) invalid();
  return {
    accepts: previous.accepts,
    min: character === "+" ? 1 : 0,
    repeat: character !== "?",
  };
}

function advance(atom: Atom, positions: Uint8Array, next: Uint8Array, text: string): void {
  for (let index = 0; index < text.length; index++) {
    const reachable = positions[index] || (atom.repeat && next[index]);
    if (reachable && atom.accepts(text[index]!)) next[index + 1] = 1;
  }
}
