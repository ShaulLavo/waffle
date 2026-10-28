export const cases = [
  {
    script: "script with spaces.py",
    args: ["", "two words", "β", "--flag"],
    status: 0,
    stdout: '["script with spaces.py", "", "two words", "β", "--flag"]\n',
    stderr: "",
    pwd: "absent",
  },
  {
    script: "stdlib.py",
    args: [],
    status: 0,
    stdout: '{"answer": 42, "square": 49}\nstdlib file written\n',
    stderr: "",
    pwd: "stale",
  },
  { script: "exit.py", args: [], status: 7, stdout: "out\n", stderr: "err\n", pwd: "absent" },
  { script: "cwd.py", args: [], status: 0, stdout: "/home/guest\n", stderr: "", pwd: "absent" },
  { script: "cwd.py", args: [], status: 0, stdout: "/home/guest\n", stderr: "", pwd: "stale" },
] as const;

export const sources: Record<string, string> = {
  "script with spaces.py":
    "import json, sys\nprint(json.dumps([sys.argv[0].rsplit('/', 1)[-1], *sys.argv[1:]], ensure_ascii=False))\n",
  "stdlib.py":
    "import json, math\nfrom pathlib import Path\nPath('created.json').write_text(json.dumps({'answer': 42, 'square': math.isqrt(2401)}))\nprint(Path('created.json').read_text())\nprint('stdlib file written')\n",
  "exit.py": "import sys\nprint('out')\nprint('err', file=sys.stderr)\nsys.exit(7)\n",
  "cwd.py": "import os\nprint(os.getcwd())\n",
};

export type PublicUsageCase =
  | {
      readonly name: string;
      readonly kind: "script";
      readonly script: string;
      readonly input?: string;
      readonly cwd?: string;
      readonly files?: Record<string, string>;
      readonly status: number;
      readonly stdout: string;
      readonly stderr?: string;
      readonly stderrIncludes?: never;
    }
  | {
      readonly name: string;
      readonly kind: "command" | "module";
      readonly args: readonly string[];
      readonly input?: string;
      readonly cwd?: string;
      readonly files?: Record<string, string>;
      readonly status: number;
      readonly stdout: string;
      readonly stderr?: string;
      readonly stderrIncludes?: string;
    };

export const publicUsageCases: readonly PublicUsageCase[] = [
  {
    name: "piped script source runs through EOF without a final newline",
    kind: "command",
    args: ["-"],
    input: "import sys\nprint('source ✓', sys.argv[0])",
    status: 0,
    stdout: "source ✓ -\n",
    stderr: "",
  },
  {
    name: "stdin reads UTF-8 and reaches EOF",
    kind: "script",
    script: "stdin-utf8.py",
    input: "héllo\n終",
    status: 0,
    stdout: '{"text": "héllo\\n終", "bytes": 10, "eof": true}\n',
    stderr: "",
  },
  {
    name: "-c preserves empty, spaced and Unicode arguments",
    kind: "command",
    args: [
      "-c",
      "import json, sys; print(json.dumps(sys.argv, ensure_ascii=False))",
      "",
      "two words",
      "β",
    ],
    status: 0,
    stdout: '["-c", "", "two words", "β"]\n',
    stderr: "",
  },
  {
    name: "json.tool compact valid stdin",
    kind: "module",
    args: ["-m", "json.tool", "--compact"],
    input: '{"b":2,"a":"é"}\n',
    status: 0,
    stdout: '{"b":2,"a":"\\u00e9"}\n',
    stderr: "",
  },
  {
    name: "json.tool compact invalid stdin",
    kind: "module",
    args: ["-m", "json.tool", "--compact"],
    input: '{"b":\n',
    status: 1,
    stdout: "",
    stderrIncludes: "Expecting value",
  },
  {
    name: "relative Unicode and spaced filename follows cwd",
    kind: "command",
    args: ["-c", "from pathlib import Path; print(Path('name with spaces.txt').read_text())"],
    cwd: "/home/guest/資料 cwd",
    files: { "name with spaces.txt": "relative UTF-8 ✓\n" },
    status: 0,
    stdout: "relative UTF-8 ✓\n\n",
    stderr: "",
  },
  {
    name: "UTF-8 stdout, stderr, and exit status are normalized",
    kind: "command",
    args: ["-c", "import sys; print('out é'); print('err 終', file=sys.stderr); sys.exit(7)"],
    status: 7,
    stdout: "out é\n",
    stderr: "err 終\n",
  },
  {
    name: "json.tool usage error is stable",
    kind: "module",
    args: ["-m", "json.tool", "--definitely-invalid"],
    status: 2,
    stdout: "",
    stderrIncludes: "usage:",
  },
  {
    name: "script path with Unicode and spaces remains relative",
    kind: "script",
    script: "資料 dir/script with spaces.py",
    cwd: "/home/guest/資料 cwd",
    files: { "input file.txt": "payload\n" },
    status: 0,
    stdout: "payload\n",
    stderr: "",
  },
];

export const publicUsageSources: Record<string, string> = {
  "stdin-utf8.py":
    "import json, sys\ntext = sys.stdin.read()\nprint(json.dumps({'text': text, 'bytes': len(text.encode()), 'eof': sys.stdin.read() == ''}, ensure_ascii=False))\n",
  "資料 dir/script with spaces.py":
    "from pathlib import Path\nprint(Path('input file.txt').read_text(), end='')\n",
};
