import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { createRuntime } from "@waffle-os/runtime";
import type { Stream } from "../../waffle/core/descriptors.ts";
import { Wasi } from "../../waffle/core/wasi.ts";
import { FilesystemClient } from "../../waffle/fs/client.ts";
import { MemFS } from "../../waffle/fs/memory.ts";
import {
  runFamilyAcceptance,
  type FamilyAcceptanceSession,
  type LaunchRequest,
} from "../../../tools/family-acceptance.ts";
import { fastGrep, grep } from "../src/index.ts";
import { planGrep } from "../src/plan.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const empty = (name: string) => ({ name, programs: [] });

interface GrepCase {
  readonly name: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string | Uint8Array;
  readonly cwd?: string;
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  readonly symlinks?: Readonly<Record<string, string>>;
  readonly closeStdout?: boolean;
  readonly executable?: string;
  readonly expectedExit: number;
  readonly expectedStdout?: string;
  readonly expectedStdoutLinesSorted?: readonly string[];
  readonly stderrPresent?: boolean;
  readonly stderrIncludes?: string;
}

async function bounded<T>(label: string, pending: Promise<T>, milliseconds = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: deadline exceeded`)), milliseconds);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function writeFixtureFiles(
  session: FamilyAcceptanceSession,
  cwd: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = `${cwd}/${relativePath}`;
    const lastSlash = fullPath.lastIndexOf("/");
    if (lastSlash > 0) await session.filesystem.mkdirp(fullPath.slice(0, lastSlash));
    await session.filesystem.writeFile(fullPath, content);
  }
}

async function writeFixtureSymlinks(
  session: FamilyAcceptanceSession,
  cwd: string,
  symlinks: Readonly<Record<string, string>>,
): Promise<void> {
  const admin = new FilesystemClient(
    session.runtime.filesystem.connect(session.runtime.filesystem.createIdentity()),
  );
  try {
    const root = await admin.asyncCall("preopen", ["/"]);
    for (const [relativePath, target] of Object.entries(symlinks)) {
      const fullPath = `${cwd}/${relativePath}`.replace(/^\/+/, "");
      const resolved = await admin.asyncCall("resolve", [root, fullPath, false]);
      assert.equal(await admin.asyncCall("symlink", [resolved, target]), 0, `symlink ${fullPath}`);
    }
  } finally {
    admin.dispose();
  }
}

async function runCase(session: FamilyAcceptanceSession, fixture: GrepCase, index: number) {
  const cwd = fixture.cwd ?? `/grep-work-${index}`;
  await session.filesystem.mkdirp(cwd);
  if (fixture.files) await writeFixtureFiles(session, cwd, fixture.files);
  if (fixture.symlinks) await writeFixtureSymlinks(session, cwd, fixture.symlinks);
  const stdinBytes = fixture.stdin ?? "";
  const stdinFd = session.filledPipe(stdinBytes);
  const fds = fixture.closeStdout
    ? [
        { child: 0, parent: stdinFd },
        { child: 2, parent: 2 },
      ]
    : [
        { child: 0, parent: stdinFd },
        { child: 1, parent: 1 },
        { child: 2, parent: 2 },
      ];
  const launched: LaunchRequest = {
    executable: fixture.executable ?? "/usr/bin/grep",
    argv: ["grep"].concat(fixture.args),
    cwd,
    env: fixture.env ? { ...fixture.env } : { PATH: "/usr/bin:/bin", PWD: cwd, LC_ALL: "C" },
    fds,
  };
  try {
    const result = await bounded(fixture.name, session.exec(launched));
    const stdout = decoder.decode(result.stdout);
    const stderr = decoder.decode(result.stderr);
    assert.deepEqual(
      result.exit,
      { kind: "exited", code: fixture.expectedExit, status: fixture.expectedExit },
      `${fixture.name}: exit (stderr=${JSON.stringify(stderr)})`,
    );
    if (fixture.expectedStdout !== undefined) {
      assert.equal(stdout, fixture.expectedStdout, `${fixture.name}: stdout`);
    }
    if (fixture.expectedStdoutLinesSorted !== undefined) {
      const actualLines = stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .toSorted();
      const expectedLines = fixture.expectedStdoutLinesSorted.toSorted();
      assert.deepEqual(actualLines, expectedLines, `${fixture.name}: sorted stdout lines`);
    }
    if (fixture.stderrPresent !== undefined) {
      assert.equal(
        stderr.length > 0,
        fixture.stderrPresent,
        `${fixture.name}: stderr=${JSON.stringify(stderr)}`,
      );
    }
    if (fixture.stderrIncludes !== undefined) {
      assert.ok(
        stderr.includes(fixture.stderrIncludes),
        `${fixture.name}: expected stderr to include ${JSON.stringify(fixture.stderrIncludes)}, got ${JSON.stringify(stderr)}`,
      );
    }
  } finally {
    session.descriptors.close(stdinFd);
  }
}

const coreCases: readonly GrepCase[] = [
  {
    name: "numbered inverted ignore case",
    args: ["-nvi", "hit"],
    stdin: "hit\nMISS\nHIT\n",
    expectedExit: 0,
    expectedStdout: "2:MISS\n",
    stderrPresent: false,
  },
  {
    name: "extended quantifiers",
    args: ["-nE", "^(ab)+$"],
    stdin: "ab\nabab\na+b\n",
    expectedExit: 0,
    expectedStdout: "1:ab\n2:abab\n",
    stderrPresent: false,
  },
  {
    name: "fixed literal case insensitive",
    args: ["-Fin", "a+b"],
    stdin: "a+b\naaab\nA+B",
    expectedExit: 0,
    expectedStdout: "1:a+b\n3:A+B\n",
    stderrPresent: false,
  },
  {
    name: "repeated explicit patterns",
    args: ["-n", "-e", "TODO", "-e", "FIXME"],
    stdin: "TODO: one\nskip\nFIXME: two\n",
    expectedExit: 0,
    expectedStdout: "1:TODO: one\n3:FIXME: two\n",
    stderrPresent: false,
  },
  {
    name: "attached grouped pattern and later flags",
    args: ["-nFea+b", "-i"],
    stdin: "a+b\nA+B\naaab\n",
    expectedExit: 0,
    expectedStdout: "1:a+b\n2:A+B\n",
    stderrPresent: false,
  },
  {
    name: "dash pattern",
    args: ["-n", "-e", "-needle"],
    stdin: "-needle\nother\n",
    expectedExit: 0,
    expectedStdout: "1:-needle\n",
    stderrPresent: false,
  },
  {
    name: "empty pattern alternative",
    args: ["-ne", "missing", "-e", ""],
    stdin: "one\n\ntwo",
    expectedExit: 0,
    expectedStdout: "1:one\n2:\n3:two\n",
    stderrPresent: false,
  },
  {
    name: "newline alternatives within explicit patterns",
    args: ["-nE", "-e", "^a$\n^c$", "-e", "^d$"],
    stdin: "a\nb\nc\nd\n",
    expectedExit: 0,
    expectedStdout: "1:a\n3:c\n4:d\n",
    stderrPresent: false,
  },
  {
    name: "basic grouping across explicit patterns",
    args: ["-n", "-e", "^\\(ab\\)\\+$", "-e", "^a+b$"],
    stdin: "ab\nabab\na+b\n",
    expectedExit: 0,
    expectedStdout: "1:ab\n2:abab\n3:a+b\n",
    stderrPresent: false,
  },
  {
    name: "forced single filename",
    args: ["-Hn", "hit", "first"],
    files: { first: "hit\nmiss\n" },
    expectedExit: 0,
    expectedStdout: "first:1:hit\n",
    stderrPresent: false,
  },
  {
    name: "suppressed multiple filenames",
    args: ["-hn", "hit", "first", "second"],
    files: { first: "hit\nmiss\n", second: "hit\n" },
    expectedExit: 0,
    expectedStdout: "1:hit\n1:hit\n",
    stderrPresent: false,
  },
  {
    name: "file plus explicit standard input",
    args: ["-n", "hit", "first", "-"],
    files: { first: "hit\n" },
    stdin: "hit\n",
    expectedExit: 0,
    expectedStdout: "first:1:hit\n(standard input):1:hit\n",
    stderrPresent: false,
  },
  {
    name: "forced stdin filename",
    args: ["-Hn", "hit"],
    stdin: "hit\n",
    expectedExit: 0,
    expectedStdout: "(standard input):1:hit\n",
    stderrPresent: false,
  },
  {
    name: "last filename option wins (-Hh)",
    args: ["-Hh", "hit", "first"],
    files: { first: "hit\n" },
    expectedExit: 0,
    expectedStdout: "hit\n",
    stderrPresent: false,
  },
  {
    name: "last filename option wins (-hH)",
    args: ["-hH", "hit", "first"],
    files: { first: "hit\n" },
    expectedExit: 0,
    expectedStdout: "first:hit\n",
    stderrPresent: false,
  },
  {
    name: "counts remain per operand",
    args: ["-hc", "-e", "hit", "first", "second"],
    files: { first: "hit\nmiss\nhit", second: "miss\n" },
    expectedExit: 0,
    expectedStdout: "2\n0\n",
    stderrPresent: false,
  },
  {
    name: "option terminator and dash filename",
    args: ["-n", "-e", "hit", "--", "-input"],
    files: { "-input": "hit\n" },
    expectedExit: 0,
    expectedStdout: "1:hit\n",
    stderrPresent: false,
  },
  {
    name: "pattern option after operand",
    args: ["first", "-ne", "hit"],
    files: { first: "hit\nmiss\n" },
    expectedExit: 0,
    expectedStdout: "1:hit\n",
    stderrPresent: false,
  },
  {
    name: "no match status",
    args: ["-e", "absent", "-e", "missing"],
    stdin: "hit\n",
    expectedExit: 1,
    expectedStdout: "",
    stderrPresent: false,
  },
  {
    name: "count no match status",
    args: ["-c", "-e", "absent"],
    stdin: "hit\n",
    expectedExit: 1,
    expectedStdout: "0\n",
    stderrPresent: false,
  },
  {
    name: "invalid regex status",
    args: ["-E", "-e", "["],
    expectedExit: 2,
    expectedStdout: "",
    stderrPresent: true,
  },
  {
    name: "missing explicit pattern status",
    args: ["-e"],
    expectedExit: 2,
    expectedStdout: "",
    stderrPresent: true,
  },
  {
    name: "missing file status",
    args: ["-e", "hit", "absent-file"],
    expectedExit: 2,
    expectedStdout: "",
    stderrPresent: true,
  },
  {
    name: "quiet success takes priority over file error",
    args: ["-q", "-e", "hit", "absent-file", "first"],
    files: { first: "hit\n" },
    expectedExit: 0,
    expectedStdout: "",
    stderrPresent: true,
  },
  {
    name: "non quiet error takes priority over match",
    args: ["-h", "-e", "hit", "absent-file", "first"],
    files: { first: "hit\n" },
    expectedExit: 2,
    expectedStdout: "hit\n",
    stderrPresent: true,
  },
  {
    name: "closed stdout returns error status 2",
    args: ["-e", "hit"],
    stdin: "hit\n",
    closeStdout: true,
    expectedExit: 2,
    stderrPresent: true,
  },
  {
    name: "alias /bin/grep executes cleanly",
    executable: "/bin/grep",
    args: ["-n", "needle"],
    stdin: "miss\nneedle\n",
    expectedExit: 0,
    expectedStdout: "2:needle\n",
    stderrPresent: false,
  },
];

const realWorldCases: readonly GrepCase[] = [
  {
    name: "-o prints every match per line with line numbers",
    args: ["-noE", "[0-9]+"],
    stdin: "a12b34\nnone\nc567\n",
    expectedExit: 0,
    expectedStdout: "1:12\n1:34\n3:567\n",
    stderrPresent: false,
  },
  {
    name: "-l and -L select matching and non-matching files",
    args: ["-l", "needle", "a.txt", "b.txt", "c.txt"],
    files: { "a.txt": "needle\n", "b.txt": "nope\n", "c.txt": "needle\n" },
    expectedExit: 0,
    expectedStdout: "a.txt\nc.txt\n",
    stderrPresent: false,
  },
  {
    name: "-L selects files without matches (mixed files -> exit 0)",
    args: ["-L", "needle", "a.txt", "b.txt", "c.txt"],
    files: { "a.txt": "needle\n", "b.txt": "nope\n", "c.txt": "needle\n" },
    expectedExit: 0,
    expectedStdout: "b.txt\n",
    stderrPresent: false,
  },
  {
    name: "-L single unmatched file prints filename and exits 1 (GNU semantics)",
    args: ["-L", "needle", "b.txt"],
    files: { "b.txt": "nope\n" },
    expectedExit: 1,
    expectedStdout: "b.txt\n",
    stderrPresent: false,
  },
  {
    name: "-L single matched file prints nothing and exits 0 (GNU semantics)",
    args: ["-L", "needle", "a.txt"],
    files: { "a.txt": "needle\n" },
    expectedExit: 0,
    expectedStdout: "",
    stderrPresent: false,
  },
  {
    name: "-A and -B context with group separator",
    args: ["-B1", "-A1", "hit"],
    stdin: "1\nhit-a\n3\n4\n5\nhit-b\n7\n",
    expectedExit: 0,
    expectedStdout: "1\nhit-a\n3\n--\n5\nhit-b\n7\n",
    stderrPresent: false,
  },
  {
    name: "-C context symmetric lines",
    args: ["-C", "1", "-n", "target"],
    stdin: "a\nb\ntarget\nd\ne\n",
    expectedExit: 0,
    expectedStdout: "2-b\n3:target\n4-d\n",
    stderrPresent: false,
  },
  {
    name: "-w whole-word match retries later in line",
    args: ["-w", "foo"],
    stdin: "foobar foo\nfoobar\n_foo\nfoo_bar\nbar-foo!\n",
    expectedExit: 0,
    expectedStdout: "foobar foo\nbar-foo!\n",
    stderrPresent: false,
  },
  {
    name: "-x whole-line match",
    args: ["-x", "exact"],
    stdin: "exact\nexact2\n exact\n",
    expectedExit: 0,
    expectedStdout: "exact\n",
    stderrPresent: false,
  },
  {
    name: "-m stops after max count",
    args: ["-m", "2", "hit"],
    stdin: "hit1\nhit2\nhit3\n",
    expectedExit: 0,
    expectedStdout: "hit1\nhit2\n",
    stderrPresent: false,
  },
  {
    name: "-f reads patterns from file",
    args: ["-f", "pats.txt", "data.txt"],
    files: { "pats.txt": "alpha\ngamma\n", "data.txt": "alpha\nbeta\ngamma\n" },
    expectedExit: 0,
    expectedStdout: "alpha\ngamma\n",
    stderrPresent: false,
  },
  {
    name: "directory operand without -r reports Is a directory (EISDIR)",
    args: ["needle", "sub"],
    files: { "sub/a.txt": "needle\n" },
    expectedExit: 2,
    expectedStdout: "",
    stderrIncludes: "Is a directory",
  },
  {
    name: "-d skip ignores directory without error",
    args: ["-d", "skip", "needle", "sub"],
    files: { "sub/a.txt": "needle\n" },
    expectedExit: 1,
    expectedStdout: "",
    stderrPresent: false,
  },
  {
    name: "-r with --include and --exclude-dir",
    args: ["-rn", "--include=*.ts", "--exclude-dir=node_modules", "error", "src"],
    files: {
      "src/app.ts": "const ok = 1;\nthrow error;\n",
      "src/readme.md": "error in docs\n",
      "src/node_modules/pkg.ts": "error in dep\n",
      "src/nested/util.ts": "return error;\n",
    },
    expectedExit: 0,
    expectedStdoutLinesSorted: ["src/app.ts:2:throw error;", "src/nested/util.ts:1:return error;"],
    stderrPresent: false,
  },
  {
    name: "-r skips internal symlinks while -R follows them",
    args: ["-r", "needle", "tree"],
    files: { "tree/a.txt": "needle\n", "tree/sub/b.txt": "needle\n" },
    symlinks: { "tree/file-link": "a.txt", "tree/dir-link": "sub" },
    expectedExit: 0,
    expectedStdoutLinesSorted: ["tree/a.txt:needle", "tree/sub/b.txt:needle"],
    stderrPresent: false,
  },
  {
    name: "-r follows explicit command-line symlink operand",
    args: ["-r", "needle", "tree/dir-link"],
    files: { "tree/sub/b.txt": "needle\n" },
    symlinks: { "tree/dir-link": "sub" },
    expectedExit: 0,
    expectedStdout: "tree/dir-link/b.txt:needle\n",
    stderrPresent: false,
  },
  {
    name: "-R follows internal file and directory symlinks",
    args: ["-R", "needle", "tree"],
    files: { "tree/a.txt": "needle\n", "tree/sub/b.txt": "needle\n" },
    symlinks: { "tree/file-link": "a.txt", "tree/dir-link": "sub" },
    expectedExit: 0,
    expectedStdoutLinesSorted: [
      "tree/a.txt:needle",
      "tree/sub/b.txt:needle",
      "tree/file-link:needle",
      "tree/dir-link/b.txt:needle",
    ],
    stderrPresent: false,
  },
  {
    name: "binary file reports Binary file matches by default",
    args: ["needle", "bin.dat"],
    files: { "bin.dat": Uint8Array.from([0x61, 0x00, ...encoder.encode("needle\n")]) },
    expectedExit: 0,
    expectedStdout: "Binary file bin.dat matches\n",
    stderrPresent: false,
  },
  {
    name: "-I skips binary files",
    args: ["-I", "needle", "bin.dat"],
    files: { "bin.dat": Uint8Array.from([0x61, 0x00, ...encoder.encode("needle\n")]) },
    expectedExit: 1,
    expectedStdout: "",
    stderrPresent: false,
  },
  {
    name: "-aF matches fixed string after embedded NUL bytes",
    args: ["-aF", "needle", "bin.dat"],
    files: { "bin.dat": Uint8Array.from([0x61, 0x00, ...encoder.encode("needle\n")]) },
    expectedExit: 0,
    expectedStdout: "a\0needle\n",
    stderrPresent: false,
  },
  {
    name: "-aE matches regex after embedded NUL bytes",
    args: ["-aE", "nee[d]le", "bin.dat"],
    files: { "bin.dat": Uint8Array.from([0x61, 0x00, ...encoder.encode("needle\n")]) },
    expectedExit: 0,
    expectedStdout: "a\0needle\n",
    stderrPresent: false,
  },
  {
    name: "-aE spanning embedded NUL byte follows documented musl regex segment boundary",
    args: ["-aE", "a.b", "bin.dat"],
    files: { "bin.dat": Uint8Array.from([0x61, 0x00, 0x62, 0x0a]) },
    expectedExit: 1,
    expectedStdout: "",
    stderrPresent: false,
  },
  {
    name: "-Fi folds non-ASCII UTF-8 characters under LC_ALL=C.UTF-8",
    args: ["-Fi", "ä"],
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C.UTF-8" },
    stdin: "Ä\n",
    expectedExit: 0,
    expectedStdout: "Ä\n",
    stderrPresent: false,
  },
  {
    name: "-Fi stays byte-wise under LC_ALL=C",
    args: ["-Fi", "ä"],
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    stdin: "Ä\n",
    expectedExit: 1,
    expectedStdout: "",
    stderrPresent: false,
  },
  {
    name: "-oFi emits the full multibyte UTF-8 span for U+017F long s",
    args: ["-oFi", "s"],
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C.UTF-8" },
    stdin: "ſ\n",
    expectedExit: 0,
    expectedStdout: "ſ\n",
    stderrPresent: false,
  },
  {
    name: "-Fi folds dotless i under LC_ALL=C.UTF-8 and rejects non-towupper pairs",
    args: ["-Fi", "i"],
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C.UTF-8" },
    stdin: "ı\nİ\n",
    expectedExit: 0,
    expectedStdout: "ı\n",
    stderrPresent: false,
  },
  {
    name: "-Fi rejects Kelvin sign for k under LC_ALL=C.UTF-8 matching GNU and fastGrep",
    args: ["-Fi", "k"],
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C.UTF-8" },
    stdin: "K\n",
    expectedExit: 1,
    expectedStdout: "",
    stderrPresent: false,
  },
  {
    name: "-cl suppresses counts and prints matching filenames only",
    args: ["-cl", "hit", "a.txt", "b.txt"],
    files: { "a.txt": "hit\nhit\n", "b.txt": "miss\n" },
    expectedExit: 0,
    expectedStdout: "a.txt\n",
    stderrPresent: false,
  },
  {
    name: "-cL suppresses counts and prints non-matching filenames only",
    args: ["-cL", "hit", "a.txt", "b.txt"],
    files: { "a.txt": "hit\n", "b.txt": "miss\n" },
    expectedExit: 0,
    expectedStdout: "b.txt\n",
    stderrPresent: false,
  },
  {
    name: "-oE with empty alternation branch keeps non-empty matches on regex path",
    args: ["-oE", "a|"],
    stdin: "a\nb\n",
    expectedExit: 0,
    expectedStdout: "a\n",
    stderrPresent: false,
  },
  {
    name: "-oE with leading empty alternation branch keeps non-empty matches",
    args: ["-oE", "|a"],
    stdin: "a\nb\n",
    expectedExit: 0,
    expectedStdout: "a\n",
    stderrPresent: false,
  },
  {
    name: "-wE with empty alternation branch preserves non-word line matches",
    args: ["-wE", "a|"],
    stdin: "!\na\n",
    expectedExit: 0,
    expectedStdout: "!\na\n",
    stderrPresent: false,
  },
  {
    name: "--exclude matches directory-qualified explicit file operand",
    args: ["--exclude=dir/file", "hit", "dir/file"],
    files: { "dir/file": "hit\n" },
    expectedExit: 1,
    expectedStdout: "",
    stderrPresent: false,
  },
  {
    name: "--include matches directory-qualified explicit file operand",
    args: ["--include=dir/file", "hit", "dir/file"],
    files: { "dir/file": "hit\n" },
    expectedExit: 0,
    expectedStdout: "hit\n",
    stderrPresent: false,
  },
  {
    name: "--exclude wildcard matches directory-qualified explicit file operand",
    args: ["--exclude=dir/*", "hit", "dir/file"],
    files: { "dir/file": "hit\n" },
    expectedExit: 1,
    expectedStdout: "",
    stderrPresent: false,
  },
  {
    name: "-r --exclude matches directory-qualified explicit file operand at FTS_ROOTLEVEL",
    args: ["-r", "--exclude=dir/file", "hit", "dir/file"],
    files: { "dir/file": "hit\n" },
    expectedExit: 1,
    expectedStdout: "",
    stderrPresent: false,
  },
  {
    name: "-r --include matches directory-qualified explicit file operand at FTS_ROOTLEVEL",
    args: ["-r", "--include=dir/file", "hit", "dir/file"],
    files: { "dir/file": "hit\n" },
    expectedExit: 0,
    expectedStdout: "dir/file:hit\n",
    stderrPresent: false,
  },
  {
    name: "--exclude still reports missing explicit operand as status 2 (non-recursive)",
    args: ["--exclude=missing*", "hit", "missing.txt", "good.txt"],
    files: { "good.txt": "hit\n" },
    expectedExit: 2,
    expectedStdout: "good.txt:hit\n",
    stderrIncludes: "missing.txt",
  },
  {
    name: "-r --exclude still reports missing explicit operand as status 2",
    args: ["-r", "--exclude=missing*", "hit", "missing.txt", "good.txt"],
    files: { "good.txt": "hit\n" },
    expectedExit: 2,
    expectedStdout: "good.txt:hit\n",
    stderrIncludes: "missing.txt",
  },
  {
    name: "-r preserves explicit stdin operand -",
    args: ["-r", "hit", "-"],
    stdin: "hit\n",
    expectedExit: 0,
    expectedStdout: "(standard input):hit\n",
    stderrPresent: false,
  },
];

async function proveQuietEarlyBail(session: FamilyAcceptanceSession): Promise<void> {
  await session.filesystem.mkdirp("/quiet-bail/tree");
  await session.filesystem.writeFile("/quiet-bail/hit.txt", "hit\n");
  await session.filesystem.writeFile("/quiet-bail/tree/a.txt", "hit\n");
  await session.filesystem.writeFile("/quiet-bail/tree/b.txt", "miss\n");
  const [reader, writer] = session.pipe();
  const stdinFd = session.descriptors.open(reader, 2n | 0x0820_0000n, 0n);
  const openPipeLaunch: LaunchRequest = {
    executable: "/usr/bin/grep",
    argv: ["grep", "-q", "hit", "/quiet-bail/hit.txt", "-"],
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    fds: [
      { child: 0, parent: stdinFd },
      { child: 1, parent: 1 },
      { child: 2, parent: 2 },
    ],
  };
  try {
    const result = await bounded(
      "quiet stops before open stdin",
      session.exec(openPipeLaunch),
      5_000,
    );
    assert.deepEqual(result.exit, { kind: "exited", code: 0, status: 0 });
    assert.equal(decoder.decode(result.stdout), "");
    assert.equal(decoder.decode(result.stderr), "");
  } finally {
    writer.close?.();
    session.descriptors.close(stdinFd);
  }
  const [listReader, listWriter] = session.pipe();
  const listStdinFd = session.descriptors.open(listReader, 2n | 0x0820_0000n, 0n);
  const hitChunk = encoder.encode("hit\n");
  assert.equal(listWriter.write([hitChunk]), hitChunk.length);
  try {
    const result = await bounded(
      "-L stops reading open stdin on first match",
      session.exec({
        executable: "/usr/bin/grep",
        argv: ["grep", "-L", "hit"],
        cwd: "/",
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        fds: [
          { child: 0, parent: listStdinFd },
          { child: 1, parent: 1 },
          { child: 2, parent: 2 },
        ],
      }),
      5_000,
    );
    assert.deepEqual(result.exit, { kind: "exited", code: 0, status: 0 });
    assert.equal(decoder.decode(result.stdout), "");
    assert.equal(decoder.decode(result.stderr), "");
  } finally {
    listWriter.close?.();
    session.descriptors.close(listStdinFd);
  }
  const followups: readonly { readonly label: string; readonly argv: readonly string[] }[] = [
    {
      label: "quiet stops before later missing operand",
      argv: ["grep", "-q", "hit", "/quiet-bail/hit.txt", "/quiet-bail/absent.txt"],
    },
    {
      label: "quiet recursive stops cleanly on first matching file",
      argv: ["grep", "-qr", "hit", "/quiet-bail/tree"],
    },
  ];
  for (const item of followups) {
    const emptyStdin = session.filledPipe("");
    try {
      const result = await bounded(
        item.label,
        session.exec({
          executable: "/usr/bin/grep",
          argv: item.argv,
          cwd: "/",
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
          fds: [
            { child: 0, parent: emptyStdin },
            { child: 1, parent: 1 },
            { child: 2, parent: 2 },
          ],
        }),
      );
      assert.deepEqual(result.exit, { kind: "exited", code: 0, status: 0 }, item.label);
      assert.equal(decoder.decode(result.stdout), "", item.label);
      assert.equal(decoder.decode(result.stderr), "", item.label);
    } finally {
      session.descriptors.close(emptyStdin);
    }
  }
}

async function proveBrokenStdoutPipe(session: FamilyAcceptanceSession): Promise<void> {
  await session.filesystem.writeFile("/broken-pipe-large.txt", "hit payload line\n".repeat(4000));
  const scenarios = [
    { label: "single-line broken pipe", args: ["-e", "hit"], stdin: "hit\n" },
    {
      label: "multi-line mid-stream broken pipe",
      args: ["-e", "hit", "/broken-pipe-large.txt"],
      stdin: "",
    },
  ] as const;
  for (const scenario of scenarios) {
    const [reader, writer] = session.pipe();
    const stdinFd = session.filledPipe(scenario.stdin);
    const stdoutFd = session.descriptors.open(writer, 0x40n | 0x0820_0000n, 0n);
    reader.close?.();
    const launched: LaunchRequest = {
      executable: "/usr/bin/grep",
      argv: ["grep"].concat(scenario.args),
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      fds: [
        { child: 0, parent: stdinFd },
        { child: 1, parent: stdoutFd },
        { child: 2, parent: 2 },
      ],
    };
    try {
      const result = await bounded(scenario.label, session.exec(launched));
      assert.equal(
        result.exit.status,
        141,
        `${scenario.label}: expected status 141, got ${JSON.stringify(result.exit)} stderr=${JSON.stringify(decoder.decode(result.stderr))}`,
      );
      assert.equal(decoder.decode(result.stderr), "", `${scenario.label}: stderr must be empty`);
    } finally {
      session.descriptors.close(stdinFd);
      session.descriptors.close(stdoutFd);
    }
  }
}

async function proveRuntimeProcCwd(session: FamilyAcceptanceSession): Promise<void> {
  await session.filesystem.mkdirp("/review");
  await session.filesystem.writeFile("/file", "root-hit\n");
  await session.filesystem.writeFile("/review/file", "review-hit\n");
  const cases: readonly {
    readonly label: string;
    readonly env: Record<string, string>;
    readonly args: readonly string[];
  }[] = [
    {
      label: "PWD unset uses runtime_proc.cwd",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      args: ["hit", "file"],
    },
    {
      label: "PWD=/ still uses runtime_proc.cwd /review",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", PWD: "/" },
      args: ["hit", "file"],
    },
    {
      label: "stale PWD=/absent does not break absolute operand",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", PWD: "/absent" },
      args: ["hit", "/review/file"],
    },
    {
      label: "stale PWD=/absent still resolves relative operand against /review",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", PWD: "/absent" },
      args: ["hit", "file"],
    },
  ];
  for (const entry of cases) {
    const stdinFd = session.filledPipe("");
    const launched: LaunchRequest = {
      executable: "/usr/bin/grep",
      argv: ["grep"].concat(entry.args),
      cwd: "/review",
      env: entry.env,
      fds: [
        { child: 0, parent: stdinFd },
        { child: 1, parent: 1 },
        { child: 2, parent: 2 },
      ],
    };
    try {
      const result = await bounded(entry.label, session.exec(launched));
      assert.deepEqual(
        result.exit,
        { kind: "exited", code: 0, status: 0 },
        `${entry.label}: stderr=${JSON.stringify(decoder.decode(result.stderr))}`,
      );
      assert.equal(decoder.decode(result.stdout), "review-hit\n", entry.label);
      assert.equal(decoder.decode(result.stderr), "", entry.label);
    } finally {
      session.descriptors.close(stdinFd);
    }
  }
}

async function proveDevFd7(session: FamilyAcceptanceSession): Promise<void> {
  const seven = session.filledPipe("one\ntwo\n");
  const launched: LaunchRequest = {
    executable: "/usr/bin/grep",
    argv: ["grep", "tw", "/dev/fd/7"],
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", PWD: "/", LC_ALL: "C" },
    fds: [
      { child: 0, parent: 0 },
      { child: 1, parent: 1 },
      { child: 2, parent: 2 },
      { child: 7, parent: seven },
    ],
  };
  try {
    const result = await bounded("/dev/fd/7", session.exec(launched));
    assert.deepEqual(result.exit, { kind: "exited", code: 0, status: 0 });
    assert.equal(decoder.decode(result.stdout), "two\n");
    assert.equal(decoder.decode(result.stderr), "");
  } finally {
    session.descriptors.close(seven);
  }
}

test("FreeBSD grep WASI binary passes core usage cases, real-world flags, EISDIR, symlinks, and /dev/fd/N", async () => {
  const runtime = createRuntime({
    filesystem: {
      mode: "memory",
      workerURL: new URL("../../waffle/browser/fs-worker.ts", import.meta.url),
    },
    programs: { onDemand: [grep] },
  });
  try {
    await bounded("grep catalog ready", runtime.programs.ready);
    await runFamilyAcceptance({
      runtime,
      workerUrl: new URL("../../waffle/browser/preview1-worker.ts", import.meta.url),
      assets: {
        coreutils: empty("coreutils"),
        findutils: empty("findutils"),
        grep: empty("grep"),
        sed: empty("sed"),
        ripgrep: empty("ripgrep"),
      },
      cases: [
        {
          name: "core grep usage contract",
          family: "grep",
          async run(session) {
            for (const [index, fixture] of coreCases.entries()) {
              await runCase(session, fixture, index);
            }
          },
        },
        {
          name: "real-world FreeBSD grep options, recursion, symlinks, EISDIR, binary",
          family: "grep",
          async run(session) {
            for (const [index, fixture] of realWorldCases.entries()) {
              await runCase(session, fixture, coreCases.length + index);
            }
          },
        },
        {
          name: "forwarded /dev/fd/7 descriptor",
          family: "grep",
          run: proveDevFd7,
        },
        {
          name: "broken stdout pipe exits 141 silently",
          family: "grep",
          run: proveBrokenStdoutPipe,
        },
        {
          name: "runtime_proc.cwd overrides missing or stale PWD",
          family: "grep",
          run: proveRuntimeProcCwd,
        },
        {
          name: "quiet mode stops before later operands and open stdin",
          family: "grep",
          run: proveQuietEarlyBail,
        },
      ],
    });
  } finally {
    await runtime.dispose();
  }
}, 90_000);

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function createFaultyReadPipe(payload: Uint8Array, errno: number): Stream {
  let offset = 0;
  const readInto = (iovecs: readonly Uint8Array[]): number => {
    if (offset >= payload.length) return -errno;
    let written = 0;
    for (const chunk of iovecs) {
      if (offset >= payload.length) break;
      const take = Math.min(chunk.length, payload.length - offset);
      chunk.set(payload.subarray(offset, offset + take));
      offset += take;
      written += take;
    }
    return written;
  };
  return {
    kind: "pipe",
    read: readInto,
    tryRead: readInto,
    write: () => -9,
    tryWrite: () => -9,
    readiness: () => ({ readable: true, writable: false, hangup: false }),
  };
}

function runDirectGrepWithFaultyStdin(
  module: WebAssembly.Module,
  args: readonly string[],
  payload: Uint8Array,
  errno: number,
): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  let memory: WebAssembly.Memory | undefined;
  const wasi = new Wasi({
    args: ["grep"].concat(args),
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    fs: new MemFS(),
    preopens: { "/": "/" },
    stdio: { 0: createFaultyReadPipe(payload, errno) },
    namespaces: {
      runtime_proc: {
        cwd: (ptr: number, cap: number) => {
          if (cap === 0) return 1;
          if (!memory || cap < 1) return -68;
          new Uint8Array(memory.buffer)[ptr >>> 0] = 0x2f;
          return 1;
        },
      },
    },
    stdout: (chunk) => stdoutChunks.push(chunk.slice()),
    stderr: (chunk) => stderrChunks.push(chunk.slice()),
    sleep() {},
  });
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  memory = instance.exports.memory as WebAssembly.Memory;
  const status = wasi.start(instance);
  return {
    status,
    stdout: decoder.decode(concatChunks(stdoutChunks)),
    stderr: decoder.decode(concatChunks(stderrChunks)),
  };
}

test("mid-stream stdin read failure reports error status 2 and preserves -q match precedence", () => {
  const bytes = readFileSync(new URL("../dist/grep.wasm", import.meta.url));
  const module = new WebAssembly.Module(bytes);
  const EIO = 29;
  const hitPayload = encoder.encode("hit\n".repeat(10_000));
  const missPayload = encoder.encode("miss\n".repeat(8_000));

  const countResult = runDirectGrepWithFaultyStdin(module, ["-c", "hit"], hitPayload, EIO);
  assert.equal(countResult.status, 2, `count stderr=${JSON.stringify(countResult.stderr)}`);
  assert.ok(
    countResult.stderr.includes("I/O error"),
    `expected I/O error diagnostic, got ${JSON.stringify(countResult.stderr)}`,
  );

  const quietResult = runDirectGrepWithFaultyStdin(module, ["-q", "hit"], hitPayload, EIO);
  assert.equal(quietResult.status, 0);
  assert.equal(quietResult.stdout, "");
  assert.equal(quietResult.stderr, "");

  const filesWithoutMatchMatched = runDirectGrepWithFaultyStdin(
    module,
    ["-L", "hit"],
    hitPayload,
    EIO,
  );
  assert.equal(filesWithoutMatchMatched.status, 0);
  assert.equal(filesWithoutMatchMatched.stdout, "");
  assert.equal(filesWithoutMatchMatched.stderr, "");

  const filesWithoutMatch = runDirectGrepWithFaultyStdin(module, ["-L", "hit"], missPayload, EIO);
  assert.equal(
    filesWithoutMatch.status,
    2,
    `-L stderr=${JSON.stringify(filesWithoutMatch.stderr)}`,
  );
  assert.equal(filesWithoutMatch.stdout, "");
  assert.ok(
    filesWithoutMatch.stderr.includes("I/O error"),
    `expected I/O error diagnostic, got ${JSON.stringify(filesWithoutMatch.stderr)}`,
  );
});

interface ParityVector {
  readonly label: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly expectFast: boolean;
  readonly expectedExit: number;
  readonly expectedStdout: string;
  readonly stderrIncludes?: string;
}

const parityFiles: Readonly<Record<string, string>> = {
  f: "one\ntwo\none\n",
  u: "ſ\n",
  dotless: "ı\n",
  umlaut: "Ä\n",
  turkish: "İ\n",
  kelvin: "K\n",
  "visible.txt": "dotval\n",
  ".hidden": "dotval\n",
  "dir/file": "fval\n",
  "outer/dir/file.txt": "fval\n",
};

const parityVectors: readonly ParityVector[] = [
  {
    label: "-raH --include=dir* matches intermediate suffix of explicit operand",
    args: ["-raH", "--include=dir*", "fval", "outer/dir/file.txt"],
    env: { PATH: "/usr/bin:/bin", PWD: "/parity", LC_ALL: "C" },
    expectFast: true,
    expectedExit: 0,
    expectedStdout: "outer/dir/file.txt:fval\n",
  },
  {
    label: "-raH --exclude=dir* excludes intermediate suffix of explicit operand",
    args: ["-raH", "--exclude=dir*", "fval", "outer/dir/file.txt"],
    env: { PATH: "/usr/bin:/bin", PWD: "/parity", LC_ALL: "C" },
    expectFast: true,
    expectedExit: 1,
    expectedStdout: "",
  },
  {
    label: "-raH --exclude=missing* still reports missing explicit operand with status 2",
    args: ["-raH", "--exclude=missing*", "one", "missing.txt", "f"],
    env: { PATH: "/usr/bin:/bin", PWD: "/parity", LC_ALL: "C" },
    expectFast: true,
    expectedExit: 2,
    expectedStdout: "f:one\nf:one\n",
    stderrIncludes: "missing.txt",
  },
  {
    label: "-raH --exclude=dir* filters explicit file operand by full path",
    args: ["-raH", "--exclude=dir*", "fval", "dir/file"],
    env: { PATH: "/usr/bin:/bin", PWD: "/parity", LC_ALL: "C" },
    expectFast: true,
    expectedExit: 1,
    expectedStdout: "",
  },
  {
    label: "-raH --include=dir* includes explicit file operand by full path",
    args: ["-raH", "--include=dir*", "fval", "dir/file"],
    env: { PATH: "/usr/bin:/bin", PWD: "/parity", LC_ALL: "C" },
    expectFast: true,
    expectedExit: 0,
    expectedStdout: "dir/file:fval\n",
  },
  {
    label: "-raH --include=*.txt excludes non-matching explicit file operand",
    args: ["-raH", "--include=*.txt", "fval", "dir/file"],
    env: { PATH: "/usr/bin:/bin", PWD: "/parity", LC_ALL: "C" },
    expectFast: true,
    expectedExit: 1,
    expectedStdout: "",
  },
  {
    label: "-raH --include=file includes explicit file operand by basename",
    args: ["-raH", "--include=file", "fval", "dir/file"],
    env: { PATH: "/usr/bin:/bin", PWD: "/parity", LC_ALL: "C" },
    expectFast: true,
    expectedExit: 0,
    expectedStdout: "dir/file:fval\n",
  },
  {
    label: "-raH --exclude=.* excludes ./-prefixed explicit file operand",
    args: ["-raH", "--exclude=.*", "fval", "./dir/file"],
    env: { PATH: "/usr/bin:/bin", PWD: "/parity", LC_ALL: "C" },
    expectFast: true,
    expectedExit: 1,
    expectedStdout: "",
  },
  {
    label: "-raH --exclude=.* matches basename only and keeps visible files",
    args: ["-raH", "--exclude=.*", "dotval", "."],
    env: { PATH: "/usr/bin:/bin", PWD: "/parity", LC_ALL: "C" },
    expectFast: true,
    expectedExit: 0,
    expectedStdout: "./visible.txt:dotval\n",
  },
  {
    label: "-raH --include=.* matches dotfiles only by basename",
    args: ["-raH", "--include=.*", "dotval", "."],
    env: { PATH: "/usr/bin:/bin", PWD: "/parity", LC_ALL: "C" },
    expectFast: true,
    expectedExit: 0,
    expectedStdout: "./.hidden:dotval\n",
  },
  {
    label: "-raclF suppresses counts and prints matching filename",
    args: ["-raclF", "one", "."],
    env: { PATH: "/usr/bin:/bin", PWD: "/parity", LC_ALL: "C" },
    expectFast: true,
    expectedExit: 0,
    expectedStdout: "./f\n",
  },
  {
    label: "-ralcF matches regardless of flag order",
    args: ["-ralcF", "one", "."],
    env: { PATH: "/usr/bin:/bin", PWD: "/parity", LC_ALL: "C" },
    expectFast: true,
    expectedExit: 0,
    expectedStdout: "./f\n",
  },
  {
    label: "-raHFi folds long s under LC_ALL=C.UTF-8",
    args: ["-raHFi", "s", "."],
    env: { PATH: "/usr/bin:/bin", PWD: "/parity", LC_ALL: "C.UTF-8" },
    expectFast: true,
    expectedExit: 0,
    expectedStdout: "./u:ſ\n",
  },
  {
    label: "-raHi literal BRE folds long s under LC_ALL=C.UTF-8",
    args: ["-raHi", "s", "."],
    env: { PATH: "/usr/bin:/bin", PWD: "/parity", LC_ALL: "C.UTF-8" },
    expectFast: true,
    expectedExit: 0,
    expectedStdout: "./u:ſ\n",
  },
  {
    label: "-raHiE literal ERE folds long s under LC_ALL=C.UTF-8",
    args: ["-raHiE", "s", "."],
    env: { PATH: "/usr/bin:/bin", PWD: "/parity", LC_ALL: "C.UTF-8" },
    expectFast: true,
    expectedExit: 0,
    expectedStdout: "./u:ſ\n",
  },
  {
    label: "-raHiE literal ERE alternation folds long s under LC_ALL=C.UTF-8",
    args: ["-raHiE", "s|nomatch", "."],
    env: { PATH: "/usr/bin:/bin", PWD: "/parity", LC_ALL: "C.UTF-8" },
    expectFast: true,
    expectedExit: 0,
    expectedStdout: "./u:ſ\n",
  },
  {
    label: "-raHFi folds dotless i under LC_ALL=C.UTF-8 without matching U+0130",
    args: ["-raHFi", "i", "."],
    env: { PATH: "/usr/bin:/bin", PWD: "/parity", LC_ALL: "C.UTF-8" },
    expectFast: true,
    expectedExit: 0,
    expectedStdout: "./dotless:ı\n",
  },
  {
    label: "-raHFi does not match Kelvin sign for k under LC_ALL=C.UTF-8",
    args: ["-raHFi", "k", "."],
    env: { PATH: "/usr/bin:/bin", PWD: "/parity", LC_ALL: "C.UTF-8" },
    expectFast: true,
    expectedExit: 1,
    expectedStdout: "",
  },
  {
    label: "-raHFi stays ASCII-only under LC_ALL=C",
    args: ["-raHFi", "s", "."],
    env: { PATH: "/usr/bin:/bin", PWD: "/parity", LC_ALL: "C" },
    expectFast: true,
    expectedExit: 1,
    expectedStdout: "",
  },
  {
    label: "-raHFi defaults to C locale when locale variables are unset",
    args: ["-raHFi", "s", "."],
    env: { PATH: "/usr/bin:/bin", PWD: "/parity" },
    expectFast: true,
    expectedExit: 1,
    expectedStdout: "",
  },
  {
    label: "-raHFi non-ASCII pattern falls back cleanly and matches under C.UTF-8",
    args: ["-raHFi", "ä", "."],
    env: { PATH: "/usr/bin:/bin", PWD: "/parity", LC_ALL: "C.UTF-8" },
    expectFast: false,
    expectedExit: 0,
    expectedStdout: "./umlaut:Ä\n",
  },
];

async function collectParityResults(
  catalog: typeof grep,
): Promise<
  readonly { readonly status: number; readonly stdout: string; readonly stderr: string }[]
> {
  const results: { readonly status: number; readonly stdout: string; readonly stderr: string }[] =
    [];
  const runtime = createRuntime({
    filesystem: {
      mode: "memory",
      workerURL: new URL("../../waffle/browser/fs-worker.ts", import.meta.url),
    },
    programs: { onDemand: [catalog] },
  });
  try {
    await bounded("parity catalog ready", runtime.programs.ready);
    await runFamilyAcceptance({
      runtime,
      workerUrl: new URL("../../waffle/browser/preview1-worker.ts", import.meta.url),
      assets: {
        coreutils: empty("coreutils"),
        findutils: empty("findutils"),
        grep: empty("grep"),
        sed: empty("sed"),
        ripgrep: empty("ripgrep"),
      },
      cases: [
        {
          name: "parity vectors",
          family: "grep",
          async run(session) {
            await session.filesystem.mkdirp("/parity");
            await writeFixtureFiles(session, "/parity", parityFiles);
            for (const vector of parityVectors) {
              const stdinFd = session.filledPipe("");
              try {
                const outcome = await bounded(
                  vector.label,
                  session.exec({
                    executable: "/usr/bin/grep",
                    argv: ["grep"].concat(vector.args),
                    cwd: "/parity",
                    env: { ...vector.env },
                    fds: [
                      { child: 0, parent: stdinFd },
                      { child: 1, parent: 1 },
                      { child: 2, parent: 2 },
                    ],
                  }),
                );
                results.push({
                  status: outcome.exit.status,
                  stdout: decoder.decode(outcome.stdout),
                  stderr: decoder.decode(outcome.stderr),
                });
              } finally {
                session.descriptors.close(stdinFd);
              }
            }
          },
        },
      ],
    });
  } finally {
    await runtime.dispose();
  }
  return results;
}

test("FreeBSD grep WASI binary matches fastGrep output and exit status on admitted workloads", async () => {
  for (const vector of parityVectors) {
    const plan = planGrep(vector.args, vector.env);
    assert.equal(
      plan.kind,
      vector.expectFast ? "fast" : "fallback",
      `${vector.label}: unexpected planGrep admission`,
    );
  }
  const fastCatalog = fastGrep({
    search: new URL("../../waffle/search/search-worker.ts", import.meta.url).href,
    shard: new URL("../../waffle/search/shard-worker.ts", import.meta.url).href,
  });
  const wasiResults = await collectParityResults(grep);
  const fastResults = await collectParityResults(fastCatalog);
  for (const [index, vector] of parityVectors.entries()) {
    const wasi = wasiResults[index]!;
    const fast = fastResults[index]!;
    assert.equal(wasi.status, vector.expectedExit, `${vector.label}: FreeBSD grep.wasm status`);
    assert.equal(fast.status, vector.expectedExit, `${vector.label}: fastGrep status`);
    assert.equal(wasi.stdout, vector.expectedStdout, `${vector.label}: FreeBSD grep.wasm stdout`);
    assert.equal(fast.stdout, vector.expectedStdout, `${vector.label}: fastGrep stdout`);
    if (vector.stderrIncludes !== undefined) {
      assert.ok(
        wasi.stderr.includes(vector.stderrIncludes),
        `${vector.label}: FreeBSD grep.wasm stderr=${JSON.stringify(wasi.stderr)}`,
      );
      assert.ok(
        fast.stderr.includes(vector.stderrIncludes),
        `${vector.label}: fastGrep stderr=${JSON.stringify(fast.stderr)}`,
      );
      continue;
    }
    assert.equal(wasi.stderr, "", `${vector.label}: FreeBSD grep.wasm stderr`);
    assert.equal(fast.stderr, "", `${vector.label}: fastGrep stderr`);
  }
}, 90_000);

test("fastGrep planner admits proven recursive text subset and falls back cleanly to FreeBSD grep", () => {
  const admitted = planGrep(["-racF", "needle", "."], { LC_ALL: "C", PWD: "/work" });
  assert.equal(admitted.kind, "fast");
  const fallbackContext = planGrep(["-r", "-C", "2", "needle", "."], { LC_ALL: "C", PWD: "/work" });
  assert.equal(fallbackContext.kind, "fallback");
  const fallbackOnlyMatching = planGrep(["-ro", "needle", "."], { LC_ALL: "C", PWD: "/work" });
  assert.equal(fallbackOnlyMatching.kind, "fallback");
  const fallbackNoText = planGrep(["-r", "needle", "."], { LC_ALL: "C", PWD: "/work" });
  assert.equal(fallbackNoText.kind, "fallback");
  const catalog = fastGrep({ search: "/search-worker.js", shard: "/shard-worker.js" });
  assert.equal(catalog.name, "grep");
  assert.equal(catalog.programs.length, 1);
  assert.equal(catalog.programs[0]?.path, "/usr/bin/grep");
  assert.deepEqual(catalog.programs[0]?.aliases, ["/bin/grep"]);
});
