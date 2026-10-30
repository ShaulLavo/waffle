export interface TeeCase {
  readonly name: string;
  readonly comparison: "gnu" | "exit-current-slice";
  readonly args: string[];
  readonly input: Uint8Array;
  readonly files: Readonly<Record<string, string>>;
  readonly denied?: string;
  readonly closedStdout?: boolean;
  readonly metadata?: boolean;
}

const bytes = (text: string) => new TextEncoder().encode(text);
const input = Uint8Array.from([0, 1, 10, 13, 127, 128, 255, 65]);
const plain: Pick<TeeCase, "comparison" | "input" | "files"> = {
  comparison: "gnu",
  input,
  files: {},
};

export const teeCases: readonly TeeCase[] = [
  { ...plain, name: "stdout binary", args: [] },
  { ...plain, name: "empty input", args: [], input: bytes("") },
  { ...plain, name: "create", args: ["out"] },
  {
    ...plain,
    name: "crosses upstream read boundary",
    args: ["out", "second"],
    input: Uint8Array.from({ length: 48 * 1024 }, (_, index) => index % 251),
  },
  { ...plain, name: "truncate", args: ["out"], files: { out: "old contents\n" } },
  { ...plain, name: "append short", args: ["-a", "out"], files: { out: "prefix\n" } },
  {
    ...plain,
    name: "append long multiple",
    args: ["--append", "out", "second"],
    files: { out: "prefix\n", second: "two\n" },
  },
  { ...plain, name: "multiple", args: ["out", "second", "third"] },
  { ...plain, name: "literal dash", args: ["-"] },
  { ...plain, name: "option terminator", args: ["--", "-a"] },
  { ...plain, name: "missing parent continues", args: ["missing/out", "out"] },
  { ...plain, name: "directory output continues", args: [".", "out"] },
  {
    ...plain,
    name: "denied output continues",
    args: ["denied", "out"],
    files: { denied: "keep\n" },
    denied: "denied",
  },
  { ...plain, name: "closed stdout continues", args: ["out"], closedStdout: true },
  {
    ...plain,
    name: "warn closed stdout",
    args: ["--output-error=warn", "out"],
    closedStdout: true,
  },
  {
    ...plain,
    name: "exit closed stdout",
    comparison: "exit-current-slice",
    args: ["--output-error=exit", "out"],
    closedStdout: true,
  },
  { ...plain, name: "exit open failure", args: ["--output-error=exit", "missing/out", "out"] },
  { ...plain, name: "invalid option", args: ["--not-an-option"] },
  { ...plain, name: "invalid error mode", args: ["--output-error=other"] },
  { ...plain, name: "pipe policy", args: ["-p", "out"] },
  { ...plain, name: "help", args: ["--help"], metadata: true },
  { ...plain, name: "version", args: ["--version"], metadata: true },
];

export function teeOutputNames(fixture: TeeCase): string[] {
  return Array.from(
    new Set(
      Object.keys(fixture.files).concat(
        fixture.args.filter((arg) => ["out", "second", "third", "-", "-a", "denied"].includes(arg)),
      ),
    ),
  ).filter((name) => name !== "-a" || fixture.args.includes("--"));
}
