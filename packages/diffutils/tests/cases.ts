export interface DiffutilsCase {
  readonly name: string;
  readonly program: "diff" | "cmp";
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly exit: 0 | 1 | 2;
  readonly ignoreHeaderLines?: number;
}

export const leftText = "alpha\nbeta\ngamma\n";
export const rightText = "alpha\nbeta two\ngamma\ndelta\n";

export const fixtureFiles: Readonly<Record<string, string>> = {
  "left.txt": leftText,
  "right.txt": rightText,
  "space-left.txt": "alpha  beta\ngamma\n",
  "space-right.txt": "alpha beta\ngamma\n",
  "space-right-change.txt": "alpha beta\ngamma delta\n",
  "tree-left/common.txt": "same\n",
  "tree-left/change.txt": "one\ntwo\n",
  "tree-left/only-left.txt": "left only\n",
  "tree-left/nested/shared.txt": "nested left\n",
  "tree-right/common.txt": "same\n",
  "tree-right/change.txt": "one\nchanged\n",
  "tree-right/only-right.txt": "right only\n",
  "tree-right/nested/shared.txt": "nested right\n",
};

export const diffutilsCases: readonly DiffutilsCase[] = [
  { name: "diff identical", program: "diff", args: ["left.txt", "left.txt"], exit: 0 },
  {
    name: "diff unified",
    program: "diff",
    args: ["-u", "left.txt", "right.txt"],
    exit: 1,
    ignoreHeaderLines: 2,
  },
  {
    name: "diff unified one line",
    program: "diff",
    args: ["-U", "1", "left.txt", "right.txt"],
    exit: 1,
    ignoreHeaderLines: 2,
  },
  {
    name: "diff context",
    program: "diff",
    args: ["-c", "left.txt", "right.txt"],
    exit: 1,
    ignoreHeaderLines: 3,
  },
  {
    name: "diff context one line",
    program: "diff",
    args: ["-C", "1", "left.txt", "right.txt"],
    exit: 1,
    ignoreHeaderLines: 3,
  },
  { name: "diff quiet", program: "diff", args: ["-q", "left.txt", "right.txt"], exit: 1 },
  {
    name: "diff ignore all space",
    program: "diff",
    args: ["-w", "-u", "space-left.txt", "space-right.txt"],
    exit: 0,
  },
  {
    name: "diff ignore space change",
    program: "diff",
    args: ["-b", "-u", "space-left.txt", "space-right.txt"],
    exit: 0,
  },
  {
    name: "diff ignore all space with change",
    program: "diff",
    args: ["-w", "-u", "space-left.txt", "space-right-change.txt"],
    exit: 1,
    ignoreHeaderLines: 2,
  },
  {
    name: "diff ignore space change with change",
    program: "diff",
    args: ["-b", "-u", "space-left.txt", "space-right-change.txt"],
    exit: 1,
    ignoreHeaderLines: 2,
  },
  {
    name: "diff recursive",
    program: "diff",
    args: ["-r", "tree-left", "tree-right"],
    exit: 1,
  },
  {
    name: "diff recursive new files",
    program: "diff",
    args: ["-r", "-N", "tree-left", "tree-right"],
    exit: 1,
  },
  { name: "diff new file", program: "diff", args: ["-N", "left.txt", "missing.txt"], exit: 1 },
  {
    name: "diff stdin",
    program: "diff",
    args: ["-", "right.txt"],
    stdin: leftText,
    exit: 1,
  },
  { name: "diff missing file", program: "diff", args: ["missing.txt", "right.txt"], exit: 2 },
  { name: "cmp identical", program: "cmp", args: ["left.txt", "left.txt"], exit: 0 },
  { name: "cmp different", program: "cmp", args: ["left.txt", "right.txt"], exit: 1 },
  { name: "cmp silent", program: "cmp", args: ["-s", "left.txt", "right.txt"], exit: 1 },
  { name: "cmp list bytes", program: "cmp", args: ["-l", "left.txt", "right.txt"], exit: 1 },
  {
    name: "cmp stdin identical",
    program: "cmp",
    args: ["-", "left.txt"],
    stdin: leftText,
    exit: 0,
  },
  {
    name: "cmp stdin different",
    program: "cmp",
    args: ["-", "right.txt"],
    stdin: leftText,
    exit: 1,
  },
  {
    name: "cmp silent stdin",
    program: "cmp",
    args: ["-s", "-", "right.txt"],
    stdin: leftText,
    exit: 1,
  },
  { name: "cmp missing file", program: "cmp", args: ["missing.txt", "left.txt"], exit: 2 },
  {
    name: "cmp two stdin files",
    program: "cmp",
    args: ["-", "-"],
    stdin: leftText,
    exit: 0,
  },
];
