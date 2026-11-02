import {
  CommandError,
  output,
  pidList,
  unsupported,
  type Output,
  type ProcessRow,
} from "./model.ts";
import { options } from "./options.ts";

type Field = "pid" | "ppid" | "comm" | "args";
interface Column {
  readonly field: Field;
  readonly heading: string;
}
interface Sort {
  readonly field: Field;
  readonly direction: 1 | -1;
}
const fields = {
  pid: { heading: "PID", width: 7, numeric: true },
  ppid: { heading: "PPID", width: 7, numeric: true },
  comm: { heading: "COMMAND", width: 15, numeric: false },
  args: { heading: "COMMAND", width: 0, numeric: false },
};

export function planPs(argv: readonly string[], processes: readonly ProcessRow[]): Output {
  const parsed = options(
    argv,
    ["-e", "-A", "-w", "--no-headers"],
    ["-p", "--pid", "--ppid", "-C", "-o", "--format", "--sort", "--width", "--cols"],
  );
  if (parsed.operands.length) unsupported("BSD selection and bare operands are not supported");
  const selectors: Array<(row: ProcessRow) => boolean> = [];
  const columns: Column[] = [];
  const sorting: Sort[] = [];
  let width = 80;
  let wide = 0;
  let headings = true;
  for (const { name, value } of parsed.options) {
    if (name === "-e" || name === "-A") selectors.push(() => true);
    else if (name === "--no-headers") headings = false;
    else if (name === "-w") width = ++wide > 1 ? Infinity : 132;
    else if (name === "--width" || name === "--cols") width = parseWidth(value);
    else if (name === "-o" || name === "--format") columns.push(...parseColumns(value));
    else if (name === "--sort") sorting.push(...parseSort(value));
    else selectors.push(selection(name, value));
  }
  if (!selectors.length)
    unsupported("default terminal selection is unavailable; use -e, -p, -C, or --ppid");
  if (!columns.length)
    unsupported("default statistics are unavailable; choose -o pid,ppid,comm,args");
  const selected = processes.filter((row) => selectors.some((select) => select(row)));
  const keys = sorting.length ? sorting : [{ field: "pid", direction: 1 } satisfies Sort];
  selected.sort((left, right) => compareRows(left, right, keys));
  const lines =
    headings && columns.some((column) => column.heading !== "") ? [formatRow(columns, width)] : [];
  for (const row of selected) lines.push(formatRow(columns, width, row));
  return output(lines.length ? `${lines.join("\n")}\n` : "", selected.length > 0);
}

function parseWidth(text: string): number {
  if (!/^[0-9]+$/.test(text) || Number(text) < 1 || Number(text) > 10_000)
    throw new CommandError("width must be between 1 and 10000");
  return Number(text);
}

function field(name: string): Field {
  if (name === "pid" || name === "ppid" || name === "comm" || name === "args") return name;
  if (name === "cmd" || name === "command") return "args";
  unsupported(`field ${name} is unavailable; supported fields are pid, ppid, comm, args`);
}

function parseColumns(text: string): Column[] {
  return text.split(/[,\s]+/).map((part) => {
    const equal = part.indexOf("=");
    const key = field(equal < 0 ? part : part.slice(0, equal));
    return { field: key, heading: equal < 0 ? fields[key].heading : part.slice(equal + 1) };
  });
}

function parseSort(text: string): Sort[] {
  return text.split(",").map((part) => ({
    field: field(part.replace(/^[+-]/, "")),
    direction: part.startsWith("-") ? -1 : 1,
  }));
}

function selection(name: string, value: string): (row: ProcessRow) => boolean {
  if (name === "-C") {
    const names = value.split(",");
    if (names.some((name) => !name)) throw new CommandError("empty command name");
    return (row) => names.includes(row.comm);
  }
  const pids = new Set(pidList(value));
  return name === "--ppid" ? (row) => pids.has(row.parentPid) : (row) => pids.has(row.pid);
}

function readField(row: ProcessRow, key: Field): string | number {
  return key === "ppid" ? row.parentPid : row[key];
}

function compareRows(left: ProcessRow, right: ProcessRow, keys: readonly Sort[]): number {
  for (const key of keys) {
    const a = readField(left, key.field);
    const b = readField(right, key.field);
    const difference = a < b ? -1 : a > b ? 1 : 0;
    if (difference) return difference * key.direction;
  }
  return left.pid - right.pid;
}

function formatRow(columns: readonly Column[], width: number, row?: ProcessRow): string {
  return columns
    .map((column, index) => {
      const value = row ? String(readField(row, column.field)) : column.heading;
      const definition = fields[column.field];
      const size = Math.max(definition.width, column.heading.length);
      if (definition.numeric) return value.padStart(size);
      return index === columns.length - 1 ? value : value.padEnd(size);
    })
    .join(" ")
    .trimEnd()
    .slice(0, width);
}
