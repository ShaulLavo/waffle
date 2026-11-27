import assert from "node:assert/strict";
import { test } from "bun:test";
import { createRuntime } from "@waffle-os/runtime";
import { FilesystemClient } from "../../waffle/fs/client.ts";
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
    env: { PATH: "/usr/bin:/bin", PWD: cwd, LC_ALL: "C" },
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
    name: "-L selects files without matches",
    args: ["-L", "needle", "a.txt", "b.txt", "c.txt"],
    files: { "a.txt": "needle\n", "b.txt": "nope\n", "c.txt": "needle\n" },
    expectedExit: 0,
    expectedStdout: "b.txt\n",
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
];

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
      ],
    });
  } finally {
    await runtime.dispose();
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
