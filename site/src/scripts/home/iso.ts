// The isometric waffle drawings: a plate of pockets, a block per pocket, pipes, tags and notes.
// Everything here builds SVG markup from geometry; `board.ts` changes a drawing once it is in the
// page. Ids are `${key}${kind}${i}${j}`, so several drawings can share one document.

export type Point = readonly [number, number];
export type Cell = readonly [number, number];

const COS = Math.cos(Math.PI / 6);
const SIN = 0.5;
const THICK = 0.4;
export const INSET = 0.15;
const DEPTH = 0.28;
export const CUBE = 0.46;

export interface SheetOptions {
  key: string;
  cols: number;
  rows: number;
  unit: number;
  top: number;
  side: number;
  bottom: number;
  tagScale?: number;
}

/** Projection and bounds for a waffle of `cols` by `rows` pockets. */
export interface Sheet {
  readonly key: string;
  readonly cols: number;
  readonly rows: number;
  readonly unit: number;
  readonly width: number;
  readonly height: number;
  readonly tagScale: number;
  readonly pt: (x: number, y: number, z?: number) => Point;
  /** Stagger for the ink-in animation, advanced by each inked stroke. */
  delay: number;
}

type Extra = (sheet: Sheet) => string;

export const fix = (value: number): string => value.toFixed(1);
export const join = (points: readonly Point[]): string =>
  points.map(([x, y]) => `${fix(x)},${fix(y)}`).join(" ");
const ends = (a: Point, b: Point): string =>
  `x1="${fix(a[0])}" y1="${fix(a[1])}" x2="${fix(b[0])}" y2="${fix(b[1])}"`;

export function sheet(options: SheetOptions): Sheet {
  const { key, cols, rows, unit, top, side, bottom, tagScale = 1 } = options;
  const ox = side + rows * COS * unit;
  const pt = (x: number, y: number, z = 0): Point => [
    ox + (x - y) * COS * unit,
    top + (x + y) * SIN * unit - z * unit,
  ];
  const width = 2 * side + (cols + rows) * COS * unit;
  const height = top + (cols + rows) * SIN * unit + THICK * unit + bottom;
  return { key, cols, rows, unit, pt, width, height, tagScale, delay: 0 };
}

function ink(s: Sheet, tag: string, attrs: string, cls: string): string {
  s.delay += 16;
  return `<${tag} ${attrs} class="${cls} ink" pathLength="1" style="--d:${s.delay}"/>`;
}

function plate(s: Sheet): string {
  const { pt, cols, rows } = s;
  const sides = [
    pt(cols, 0),
    pt(cols, 0, -THICK),
    pt(cols, rows, -THICK),
    pt(0, rows, -THICK),
    pt(0, rows),
    pt(cols, rows),
  ];
  const face = [pt(0, 0), pt(cols, 0), pt(cols, rows), pt(0, rows)];
  return (
    ink(s, "polygon", `points="${join(sides)}"`, "st side") +
    ink(s, "polygon", `points="${join(face)}"`, "st top") +
    ink(s, "line", ends(pt(cols, rows), pt(cols, rows, -THICK)), "st")
  );
}

function pocket(s: Sheet, i: number, j: number): string {
  const lo = INSET;
  const hi = 1 - INSET;
  const ring = (z: number): Point[] => [
    s.pt(i + lo, j + lo, z),
    s.pt(i + hi, j + lo, z),
    s.pt(i + hi, j + hi, z),
    s.pt(i + lo, j + hi, z),
  ];
  const id = `${s.key}k${i}${j}`;
  const floor = ring(-DEPTH);
  const rim = ring(0);
  return (
    `<clipPath id="${id}"><polygon points="${join(rim)}"/></clipPath>` +
    `<polygon points="${join(floor)}" class="floor" clip-path="url(#${id})"/>` +
    ink(s, "polygon", `points="${join(floor)}" clip-path="url(#${id})"`, "st thin") +
    ink(s, "line", `${ends(rim[0]!, floor[0]!)} clip-path="url(#${id})"`, "st thin") +
    ink(s, "polygon", `points="${join(rim)}"`, "st thin")
  );
}

/** A block the size of its pocket. Its body slides vertically behind a clip that follows the pocket's front rim. */
function cube(s: Sheet, i: number, j: number): string {
  const lo = INSET;
  const hi = 1 - INSET;
  const p = (x: number, y: number, z: number): Point => s.pt(i + x, j + y, z);
  const left = p(lo, hi, 0);
  const front = p(hi, hi, 0);
  const right = p(hi, lo, 0);
  const rim: Point[] = [
    [left[0] - 2, left[1] + 1],
    [front[0], front[1] + 2],
    [right[0] + 2, right[1] + 1],
    [right[0] + 2, right[1] - 400],
    [left[0] - 2, left[1] - 400],
  ];
  const id = `${s.key}r${i}${j}`;
  const sink = fix((CUBE + DEPTH) * s.unit);
  const faceRight = [p(hi, lo, CUBE), p(hi, hi, CUBE), p(hi, hi, 0), p(hi, lo, 0)];
  const faceLeft = [p(lo, hi, CUBE), p(hi, hi, CUBE), p(hi, hi, 0), p(lo, hi, 0)];
  const faceTop = [p(lo, lo, CUBE), p(hi, lo, CUBE), p(hi, hi, CUBE), p(lo, hi, CUBE)];
  return (
    `<clipPath id="${id}"><polygon points="${join(rim)}"/></clipPath>` +
    `<g class="cube" id="${s.key}c${i}${j}"><g clip-path="url(#${id})"><g class="body" style="--sink:${sink}px">` +
    `<polygon class="fr" points="${join(faceRight)}"/>` +
    `<polygon class="fl" points="${join(faceLeft)}"/>` +
    `<polygon class="ft" points="${join(faceTop)}"/></g></g></g>`
  );
}

function pipe(s: Sheet, i: number, j: number): string {
  const line = ends(s.pt(i + 0.5, j + 0.5, CUBE), s.pt(i + 1.5, j + 0.5, CUBE));
  return `<g class="pipe" id="${s.key}p${i}${j}"><line class="under" ${line}/><line class="dots" ${line}/></g>`;
}

function tag(s: Sheet, i: number, j: number): string {
  const [cx, cy] = s.pt(i + 0.5, j + 0.5, CUBE);
  const k = s.tagScale;
  return (
    `<g class="tag" id="${s.key}t${i}${j}" transform="translate(${fix(cx)},${fix(cy - 12 * k)})">` +
    `<line x1="0" y1="0" x2="0" y2="${12 * k}"/><rect y="${-20 * k}" height="${20 * k}" rx="${10 * k}"/>` +
    `<text y="${-6 * k}" text-anchor="middle" style="font-size:${11.5 * k}px"></text></g>`
  );
}

/** File marks on the plate's front face: the filesystem sits under every pocket. */
export function ticks(s: Sheet, count: number, from: number, step: number): string {
  const marks = Array.from({ length: count }, (_, n) => {
    const x = from + n * step;
    const line = ends(s.pt(x, s.rows, -0.09), s.pt(x, s.rows, -0.31));
    return `<line class="tick" style="--n:${n}" ${line}/>`;
  });
  return `<g id="${s.key}ticks">${marks.join("")}</g>`;
}

/** The pockets on one back-to-front diagonal, where `i + j === sum`. */
function diagonal(s: Sheet, sum: number): Cell[] {
  return Array.from({ length: s.cols }, (_, i): Cell => [i, sum - i]).filter(
    ([, j]) => j >= 0 && j < s.rows,
  );
}

/** Back-to-front, so a block always covers what is behind it. Effects, pipes and tags sit on top. */
export function waffle(s: Sheet, extra: Extra = () => ""): string {
  let parts = [plate(s)];
  let cells: Cell[] = [];
  for (let sum = 0; sum <= s.cols + s.rows - 2; sum++) {
    const row = diagonal(s, sum);
    parts.push(row.map(([i, j]) => pocket(s, i, j) + cube(s, i, j)).join(""));
    cells = cells.concat(row);
  }
  const bridges = cells.filter(([i]) => i < s.cols - 1).map(([i, j]) => pipe(s, i, j));
  parts = parts.concat(
    extra(s),
    `<g id="${s.key}fx"></g>`,
    bridges.join(""),
    cells.map(([i, j]) => tag(s, i, j)).join(""),
  );
  const box = `0 0 ${s.width.toFixed(0)} ${s.height.toFixed(0)}`;
  return `<svg viewBox="${box}" aria-hidden="true">${parts.join("")}</svg>`;
}

/** A dimension line outside one front edge of the plate, with a note set along it. */
function edgeNote(from: Point, to: Point, normal: Point, angle: number, text: string): string {
  const [nx, ny] = normal;
  const mid: Point = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  const cap = (point: Point) =>
    `<line ${ends([point[0], point[1] - 7], [point[0], point[1] + 7])} class="st thin"/>`;
  const at = `translate(${fix(mid[0] + nx * 20)},${fix(mid[1] + 18)}) rotate(${angle})`;
  return (
    `<g class="note" transform="translate(${fix(nx * 30)},${fix(ny * 30)})">` +
    `<line ${ends(from, to)} class="st thin"/>${cap(from)}${cap(to)}` +
    `<text transform="${at}" text-anchor="middle">${text}</text></g>`
  );
}

/** The hero plate's file marks and its two dimension notes. */
export function heroNotes(s: Sheet): string {
  return (
    ticks(s, 21, 0.32, 0.158) +
    edgeNote(s.pt(4, 4, -THICK), s.pt(4, 0, -THICK), [SIN, COS], -30, "UP TO 1,024 PROCESSES") +
    edgeNote(s.pt(0, 4, -THICK), s.pt(4, 4, -THICK), [-SIN, COS], 30, "ONE SHARED FILESYSTEM")
  );
}

/** Upright points for the prompt glyph drawn on a block's top face. */
export function promptGlyph(s: Sheet, cell: Cell): string {
  const [x, y] = s.pt(cell[0] + 0.5, cell[1] + 0.5, CUBE);
  const chevron: Point[] = [
    [x - 13, y - 7],
    [x - 5, y],
    [x - 13, y + 7],
  ];
  return (
    `<polyline class="glyph" points="${join(chevron)}"/>` +
    `<line class="glyph caret" ${ends([x + 1, y + 7], [x + 13, y + 7])}/>`
  );
}

/** Detail C: the pipe as a ring buffer, five slots on a rail between the writer and the reader. */
export function ringBuffer(s: Sheet): string {
  const a = s.pt(1 - INSET, 0.5, CUBE);
  const b = s.pt(2 + INSET, 0.5, CUBE);
  const at = (t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const slots = [0.1, 0.3, 0.5, 0.7, 0.9].map((t) => {
    const [cx, cy] = at(t);
    return `<circle class="slot" cx="${fix(cx)}" cy="${fix(cy)}" r="4.6"/>`;
  });
  return `<g id="cbuffer"><line class="rail" ${ends(a, b)}/>${slots.join("")}</g>`;
}

/** Detail D: the loopback route between the server's pocket and the preview's. */
export const wirePoints = (s: Sheet): Point[] => [
  s.pt(0.5, 1.16),
  s.pt(0.5, 1),
  s.pt(1.5, 1),
  s.pt(1.5, 0.84),
];

export const wire = (s: Sheet): string =>
  `<polyline class="wire" points="${join(wirePoints(s))}"/>`;

/** Out of one block's pocket, along the ridges, into the target pocket. */
export function route(s: Sheet, from: Cell, to: Cell): Point[] {
  const [ai, aj] = from;
  const [bi, bj] = to;
  const ridge = bj > aj ? bj : aj + 1;
  return [
    s.pt(ai + 1, aj + 0.5),
    s.pt(ai + 1, ridge),
    s.pt(bi + 0.5, ridge),
    s.pt(bi + 0.5, bj + 0.5),
  ];
}
