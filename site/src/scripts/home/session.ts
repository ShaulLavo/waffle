// The hero: a scripted demo session in the terminal, mirrored on the process-table drawing. Every
// command lights a block per process it starts, a bridge per pipe, and file marks for what it
// writes. `plans/site-live-shell.md` replaces the script with bash-web running on Waffle.
import { cubeOf, fly, setBlock, setPipe, setTicks, tap } from "./board";
import { Gate, gateOnView } from "./gate";
import {
  CUBE,
  INSET,
  heroNotes,
  promptGlyph,
  route,
  sheet,
  waffle,
  type Cell,
  type Sheet,
} from "./iso";

type Process = readonly [name: string, cell: Cell];

interface Step {
  readonly cwd: string;
  readonly cmd: string;
  /** The working directory after the command, when it changes. */
  readonly next?: string;
  readonly procs: readonly Process[];
  readonly pipes: readonly Cell[];
  readonly out: readonly string[];
  /** File marks lit after the command, when it changes the count. */
  readonly files?: number;
}

type GaugeName = "count" | "pipes" | "files" | "spawned";

const SHELL: Cell = [0, 0];
/** The terminal view always holds exactly this many rows. */
const ROWS = 8;
const CURSOR = '<span class="cur"></span>';
const PAUSE_ICON = "M3 2h3v10H3zM8 2h3v10H8z";
const PLAY_ICON = "M3 2l9 5-9 5z";

const STEPS: readonly Step[] = [
  {
    cwd: "~",
    cmd: 'echo "hi from a tab" | tr a-z A-Z',
    procs: [
      ["echo", [1, 2]],
      ["tr", [2, 2]],
    ],
    pipes: [[1, 2]],
    out: ["HI FROM A TAB"],
  },
  {
    cwd: "~",
    cmd: "git init -q notes && cd notes",
    next: "~/notes",
    procs: [["git", [2, 1]]],
    pipes: [],
    out: [],
    files: 14,
  },
  {
    cwd: "~/notes",
    cmd: 'echo "print(6 * 7)" > answer.py',
    procs: [],
    pipes: [],
    out: [],
    files: 15,
  },
  { cwd: "~/notes", cmd: "python answer.py", procs: [["python", [3, 2]]], pipes: [], out: ["42"] },
  {
    cwd: "~/notes",
    cmd: "ls | grep py | wc -l",
    procs: [
      ["ls", [0, 3]],
      ["grep", [1, 3]],
      ["wc", [2, 3]],
    ],
    pipes: [
      [0, 3],
      [1, 3],
    ],
    out: ["1"],
  },
  {
    cwd: "~/notes",
    cmd: 'git add . && git commit -qm "first"',
    procs: [["git", [2, 1]]],
    pipes: [],
    out: [],
    files: 21,
  },
  { cwd: "~/notes", cmd: "cd", next: "~", procs: [], pipes: [], out: [] },
  { cwd: "~", cmd: "rm -rf notes", procs: [["rm", [3, 1]]], pipes: [], out: [], files: 0 },
];

/** The gauges in the reduced-motion frame, matching the pipeline it shows. */
const STILL_GAUGES: readonly (readonly [GaugeName, number])[] = [
  ["count", 4],
  ["pipes", 2],
  ["files", 15],
  ["spawned", 8],
];

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const promptFor = (cwd: string): string => `<span class="p">${cwd} $</span> `;
const commandLine = (step: Step): string => promptFor(step.cwd) + escapeHtml(step.cmd);
const output = (step: Step): string[] => step.out.map((line) => `<span class="o">${line}</span>`);
const transcript = (steps: readonly Step[]): string[] =>
  steps.flatMap((step) => [commandLine(step)].concat(output(step)));

function element<T extends Element>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`Missing #${id}`);
  return found;
}

class Session {
  readonly gate = new Gate();
  readonly hero: Sheet;
  readonly shell: SVGGElement;
  readonly tty = element("tty", HTMLElement);
  readonly gauges: Record<GaugeName, HTMLElement> = {
    count: element("count", HTMLElement),
    pipes: element("pipes", HTMLElement),
    files: element("files", HTMLElement),
    spawned: element("spawned", HTMLElement),
  };
  pid = 1;
  running = 1;
  lines: string[] = [];

  constructor(plate: HTMLElement) {
    const narrow = matchMedia("(max-width: 959px)").matches;
    this.hero = sheet({
      key: "h",
      cols: 4,
      rows: 4,
      unit: 80,
      top: 78,
      side: narrow ? 26 : 40,
      bottom: 66,
      tagScale: narrow ? 1.55 : 1,
    });
    plate.innerHTML = waffle(this.hero, heroNotes);
    this.shell = cubeOf("h", SHELL);
    this.drawShell();
  }

  /** The shell's block: a prompt on its top face and a tag raised clear of it. */
  drawShell(): void {
    this.shell
      .querySelector(".body")
      ?.insertAdjacentHTML("beforeend", promptGlyph(this.hero, SHELL));
    setBlock("h", SHELL, "bash 1", "on shell");
    const shellTag = document.getElementById(`ht${SHELL[0]}${SHELL[1]}`);
    const [x, y] = this.hero.pt(SHELL[0] + 0.5, SHELL[1] + 0.5, CUBE);
    const stem = 34 * this.hero.tagScale;
    shellTag?.setAttribute("transform", `translate(${x.toFixed(1)},${(y - stem).toFixed(1)})`);
    // The stem stops at the back corner of the top face.
    const stemEnd = stem - (1 - 2 * INSET) * 0.5 * this.hero.unit;
    shellTag?.querySelector("line")?.setAttribute("y2", String(stemEnd));
  }

  /** Always the last ROWS lines, so the view is full from its first row. */
  render(current: string | string[]): void {
    this.tty.innerHTML = this.lines.concat(current).slice(-ROWS).join("\n");
  }

  gauge(name: GaugeName, value: number): void {
    const target = this.gauges[name];
    const text = String(value);
    if (target.textContent === text) return;
    target.textContent = text;
    target.animate([{ color: "#fff" }, { color: "#ffc53d" }], { duration: 420, easing: "ease" });
  }

  sleep(ms: number): Promise<void> {
    return this.gate.sleep(ms);
  }

  async type(step: Step): Promise<void> {
    for (let i = 1; i <= step.cmd.length; i++) {
      this.render(promptFor(step.cwd) + escapeHtml(step.cmd.slice(0, i)) + CURSOR);
      await this.sleep(34 + (step.cmd[i - 1] === " " ? 40 : 0));
    }
    await this.sleep(220);
    tap(this.shell, 170, 7);
    await this.sleep(150);
  }

  async launch([name, cell]: Process, delay: number): Promise<void> {
    await this.sleep(delay);
    this.pid += 1;
    const id = this.pid;
    await fly("h", route(this.hero, SHELL, cell));
    setBlock("h", cell, `${name} ${id}`, "on");
    this.running += 1;
    this.gauge("count", this.running);
    this.gauge("spawned", id);
    await this.sleep(380);
  }

  async reap(step: Step): Promise<void> {
    for (const [, cell] of step.procs) setBlock("h", cell, "exit 0", "on done");
    for (const cell of step.pipes) setPipe("h", cell, false);
    this.gauge("pipes", 0);
    await this.sleep(520);
    for (const [, cell] of step.procs) setBlock("h", cell, "", "");
    this.running = 1;
    this.gauge("count", this.running);
    await this.sleep(280);
  }

  /** The answer travels back from the last process in the line to the shell. */
  async answer(step: Step): Promise<void> {
    const last = step.procs.at(-1);
    if (!step.out.length || !last) return;
    await fly("h", route(this.hero, SHELL, last[1]).reverse());
    tap(this.shell, 170, 5);
  }

  async runStep(step: Step): Promise<void> {
    await this.type(step);
    this.lines.push(commandLine(step));
    this.render([]);
    await Promise.all(step.procs.map((proc, n) => this.launch(proc, n * 70)));
    for (const cell of step.pipes) setPipe("h", cell, true);
    this.gauge("pipes", step.pipes.length);
    await this.sleep(step.pipes.length ? 1200 : step.procs.length ? 640 : 160);
    if (step.files !== undefined) this.files(step.files);
    await this.answer(step);
    this.lines = this.lines.concat(output(step));
    this.render([]);
    if (step.procs.length) await this.reap(step);
    this.render(promptFor(step.next ?? step.cwd) + CURSOR);
    await this.sleep(620);
  }

  files(count: number): void {
    setTicks("h", count);
    this.gauge("files", count);
  }

  async loop(): Promise<void> {
    // Start as if the session had already run once, so the terminal is full.
    this.lines = transcript(STEPS.slice(2));
    this.pid = 9;
    this.gauge("spawned", this.pid);
    this.render(promptFor("~") + CURSOR);
    await this.sleep(1500);
    for (;;) await this.cycle();
  }

  async cycle(): Promise<void> {
    for (const step of STEPS) await this.runStep(step);
  }

  /** Reduced motion: one frame of the session, the three-process pipeline mid-run. */
  still(): void {
    const shown = STEPS[4]!;
    this.lines = transcript(STEPS.slice(2)).concat(transcript(STEPS.slice(0, 4)));
    this.render(commandLine(shown));
    shown.procs.forEach(([name, cell], n) => setBlock("h", cell, `${name} ${n + 6}`, "on"));
    for (const cell of shown.pipes) setPipe("h", cell, true);
    setTicks("h", 15);
    for (const [name, value] of STILL_GAUGES) this.gauges[name].textContent = String(value);
  }
}

function bindPause(button: HTMLButtonElement, gate: Gate): void {
  const icon = document.getElementById("pauseIcon");
  button.addEventListener("click", () => {
    const paused = button.getAttribute("aria-pressed") !== "true";
    gate.set("paused", paused);
    button.setAttribute("aria-pressed", String(paused));
    button.setAttribute("aria-label", paused ? "Resume the session" : "Pause the session");
    icon?.setAttribute("d", paused ? PLAY_ICON : PAUSE_ICON);
  });
}

export function startSession(reduced: boolean): void {
  const plate = element("plate", HTMLElement);
  const stage = element("stage", HTMLElement);
  const session = new Session(plate);
  bindPause(element("pause", HTMLButtonElement), session.gate);
  if (reduced) {
    session.still();
    return;
  }
  // CSS loops (the caret and the pipe dots) stop whenever the session does.
  session.gate.onChange((open) => stage.classList.toggle("paused", !open));
  gateOnView(session.gate, stage, 0);
  void session.loop();
}
