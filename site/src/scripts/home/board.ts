// Changes to a waffle drawing once `iso.ts` has put it in the page: blocks rise and sink, tags
// change, pipes open, file marks light and a comet runs along a route.
import { fix, type Cell, type Point } from "./iso";

function byId(id: string): Element {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing drawing element #${id}`);
  return element;
}

export function cubeOf(key: string, [i, j]: Cell): SVGGElement {
  const element = byId(`${key}c${i}${j}`);
  if (!(element instanceof SVGGElement)) throw new Error(`#${key}c${i}${j} is not a block`);
  return element;
}

/** Sets a block's state classes and its tag. An empty label hides the tag. */
export function setBlock(key: string, cell: Cell, label: string, cls: string): void {
  const flag = byId(`${key}t${cell[0]}${cell[1]}`);
  cubeOf(key, cell).setAttribute("class", `cube ${cls}`);
  flag.setAttribute("class", label ? `tag ${cls}` : "tag");
  if (!label) return;
  const rect = flag.querySelector("rect");
  const text = flag.querySelector("text");
  if (!rect || !text) return;
  const scale = Number(rect.getAttribute("height")) / 20;
  const width = (label.length * 7.3 + 18) * scale;
  text.textContent = label;
  rect.setAttribute("x", fix(-width / 2));
  rect.setAttribute("width", fix(width));
}

export function setPipe(key: string, [i, j]: Cell, on: boolean): void {
  byId(`${key}p${i}${j}`).setAttribute("class", on ? "pipe on" : "pipe");
}

export function setTicks(key: string, count: number): void {
  Array.from(byId(`${key}ticks`).children, (mark, n) =>
    mark.setAttribute("class", n < count ? "tick on" : "tick"),
  );
}

/** A short dip, as if the block were a key being pressed. */
export function tap(block: SVGGElement, ms = 110, depth = 4): void {
  block.style.setProperty("--press", `${depth}px`);
  block.classList.add("press");
  setTimeout(() => block.classList.remove("press"), ms);
}

const svgNamespace = "http://www.w3.org/2000/svg";

function path(cls: string, d: string): SVGPathElement {
  const element = document.createElementNS(svgNamespace, "path");
  element.setAttribute("class", cls);
  element.setAttribute("d", d);
  return element;
}

/** A comet runs along the points and leaves a line that fades. Resolves when the comet arrives. */
export async function fly(key: string, points: readonly Point[]): Promise<void> {
  const layer = byId(`${key}fx`);
  const d = `M${points.map(([x, y]) => `${fix(x)},${fix(y)}`).join(" L")}`;
  const trace = path("trace", d);
  const comet = path("comet", d);
  layer.append(trace, comet);
  const length = comet.getTotalLength();
  const head = Math.min(44, length * 0.45);
  const ms = 240 + length * 0.9;
  comet.style.strokeDasharray = `${head} ${length + head}`;
  const fade = trace.animate([{ opacity: 0.6 }, { opacity: 0 }], {
    duration: ms + 380,
    easing: "ease",
  });
  void fade.finished.then(() => trace.remove());
  const run = comet.animate([{ strokeDashoffset: head }, { strokeDashoffset: -length }], {
    duration: ms,
    easing: "cubic-bezier(0.77, 0, 0.175, 1)",
    fill: "forwards",
  });
  await run.finished;
  comet.remove();
}
