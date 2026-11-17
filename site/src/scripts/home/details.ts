// "How it works": four small drawings, each looping one idea while the section is on screen.
import { cubeOf, fly, setBlock, setTicks, tap } from "./board";
import { Gate, gateOnView } from "./gate";
import {
  ringBuffer,
  sheet,
  ticks,
  waffle,
  wire,
  wirePoints,
  type Cell,
  type Point,
  type Sheet,
} from "./iso";

const A: Cell = [1, 0];
const GIT: Cell = [0, 0];
const PYTHON: Cell = [1, 0];
const WRITER: Cell = [0, 0];
const READER: Cell = [2, 0];
const SERVER: Cell = [0, 1];
const CLIENT: Cell = [1, 0];

const small = { unit: 56, top: 54, side: 16, bottom: 10, tagScale: 0.92 };
const square = (key: string): Sheet => sheet({ key, cols: 2, rows: 2, ...small });

function mount(id: string, markup: string): void {
  const host = document.getElementById(id);
  if (host) host.innerHTML = markup;
}

/** Slots from..to are full: the writer fills from the left, the reader empties from the left. */
function setSlots(from: number, to: number): void {
  Array.from(document.querySelectorAll("#cbuffer .slot"), (slot, n) =>
    slot.setAttribute("class", n >= from && n < to ? "slot full" : "slot"),
  );
}

/** Detail A: one process starts, exits and is replaced by the next pid. */
async function loopA(gate: Gate): Promise<void> {
  for (let n = 8; ; n++) {
    await gate.sleep(1900);
    setBlock("a", A, "exit 0", "on done");
    await gate.sleep(700);
    setBlock("a", A, "", "");
    await gate.sleep(800);
    setBlock("a", A, `pid ${n}`, "on");
  }
}

/** Detail B: git writes four files, then python reads them. */
async function roundB(gate: Gate, marks: readonly Element[]): Promise<void> {
  for (let n = 1; n <= 4; n++) {
    tap(cubeOf("b", GIT), 180, 3);
    setTicks("b", n);
    await gate.sleep(560);
  }
  await gate.sleep(400);
  for (let n = 0; n < 4; n++) {
    tap(cubeOf("b", PYTHON), 180, 3);
    marks[n]?.classList.add("read");
    await gate.sleep(560);
  }
  await gate.sleep(1000);
  setTicks("b", 0);
  await gate.sleep(700);
}

/** Detail C: the writer fills the buffer and waits until the reader drains it. */
async function roundC(gate: Gate): Promise<void> {
  for (let n = 1; n <= 5; n++) {
    setSlots(0, n);
    await gate.sleep(300);
  }
  setBlock("c", WRITER, "waits", "on wait");
  await gate.sleep(1000);
  for (let n = 1; n <= 5; n++) {
    setSlots(n, 5);
    if (n === 1) setBlock("c", WRITER, "ls", "on");
    await gate.sleep(320);
  }
  await gate.sleep(600);
}

/** Detail D: a request goes to the server's port and the response comes back. */
async function roundD(gate: Gate, out: readonly Point[]): Promise<void> {
  await fly("d", out.toReversed());
  tap(cubeOf("d", SERVER), 180, 4);
  await gate.sleep(280);
  await fly("d", out);
  tap(cubeOf("d", CLIENT), 180, 4);
  await gate.sleep(1400);
}

async function forever(round: () => Promise<void>): Promise<void> {
  for (;;) await round();
}

export function startDetails(reduced: boolean): void {
  const sheets = {
    a: square("a"),
    b: square("b"),
    c: sheet({ key: "c", cols: 3, rows: 1, ...small }),
    d: square("d"),
  };
  mount("detail-a", waffle(sheets.a));
  mount(
    "detail-b",
    waffle(sheets.b, (s) => ticks(s, 6, 0.32, 0.27)),
  );
  mount("detail-c", waffle(sheets.c, ringBuffer));
  mount("detail-d", waffle(sheets.d, wire));

  setBlock("a", A, "pid 7", "on");
  setBlock("b", GIT, "git", "on");
  setBlock("b", PYTHON, "python", "on");
  setBlock("c", WRITER, "ls", "on");
  setBlock("c", READER, "wc", "on");
  setBlock("d", SERVER, ":3000", "on");
  setBlock("d", CLIENT, "preview", "on");

  if (reduced) {
    setTicks("b", 4);
    setSlots(0, 3);
    return;
  }
  const section = document.getElementById("details");
  if (!section) return;
  const gate = new Gate();
  gateOnView(gate, section, 0.15);
  const marks = Array.from(document.getElementById("bticks")?.children ?? []);
  const out = wirePoints(sheets.d);
  void loopA(gate);
  void forever(() => roundB(gate, marks));
  void forever(() => roundC(gate));
  void forever(() => roundD(gate, out));
}
