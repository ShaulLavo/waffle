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
