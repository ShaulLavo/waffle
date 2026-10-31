import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { retireCommandGroup } from "../scripts/owned-command.ts";

const root = join(import.meta.dir, "..");
const repository = join(root, "../..");
const stopped = new AbortController();
const stop = () => stopped.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

async function mustFail(label: string, args: string[], evidence: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "run"].concat(args), {
    cwd: root,
    detached: true,
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.any([AbortSignal.timeout(120_000), stopped.signal]),
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited.finally(() => retireCommandGroup(child.pid)),
  ]);
  const output = stdout + stderr;
  if (exit === 0 || !output.includes(evidence)) {
    throw new Error(`${label}: expected a failing gate mentioning ${evidence}\n${output}`);
  }
  console.log(`PASS quality probe: ${label}`);
}

function cloneSource(name: string, salt: number): string {
  const steps = Array.from({ length: 14 }, (_, index) => {
    const shift = index + 1 + salt;
    return `  ${name}Value = Math.imul(${name}Value ^ (${name}Value >>> ${shift}), ${31 + index + salt});`;
  }).join("\n");
  return `export function ${name}(input: number): number {\n  let ${name}Value = input;\n${steps}\n  return ${name}Value;\n}\n`;
}

// Each invocation owns only these fresh paths. Cleanup also runs when a child fails or times out.
const directory = await mkdtemp(join(import.meta.dir, "quality-probe-"));
const probe = join(directory, "probe.ts");
const entry = join(root, "tests", `${basename(directory)}.test.ts`);
const javascript = entry.replace(/\.ts$/, ".js");
const site = join(repository, "site", "scripts", `${basename(directory)}.ts`);
try {
  await writeFile(probe, "var qualityProbe = 1;\nconsole.log(qualityProbe);\n");
  await mustFail("lint", ["lint"], "no-var");
  await writeFile(probe, "console.log(name);\n");
  await mustFail("accidental browser-global name", ["lint"], "no-restricted-globals");
  await writeFile(probe, "export const qualityProbe: number = 'not a number';\n");
  await mustFail("strict tooling type check", ["check:tooling"], "TS2322");
  await rm(probe);
  await writeFile(
    javascript,
    "// @ts-check\n/** @type {number} */\nconst qualityProbe = 'not a number';\nconsole.log(qualityProbe);\n",
  );
  await mustFail("handwritten JavaScript", ["check:source"], "Handwritten JavaScript");
  await mustFail("authored JavaScript type check", ["check:tooling"], "TS2322");
  await rm(javascript);
  await writeFile(site, "export const qualityProbe: number = 'not a number';\n");
  await mustFail("separate site package type check", ["--cwd", "../../site", "typecheck"], "2322");
  await rm(site);
  await writeFile(probe, "export const qualityProbe={x:1}\n");
  await mustFail("formatter", ["format:check"], relative(root, probe));
  await writeFile(probe, "export const qualityProbe = 1;\n");
  await mustFail("unused file", ["unused"], relative(root, probe));
  await rm(probe);
  await writeFile(entry, "export const unusedEntryExport = 1;\n");
  await mustFail("unused export in a real test entry", ["unused"], "unusedEntryExport");
  await rm(entry);
  await writeFile(probe, cloneSource("qualityOriginal", 0));
  await writeFile(join(directory, "copy.ts"), cloneSource("qualityOriginal", 0));
  await mustFail("new exact clone", ["duplicates"], "new clone");
  await writeFile(join(directory, "copy.ts"), cloneSource("qualityRenamed", 3));
  await mustFail("new structural clone", ["duplicates", "--kind", "similar"], "new clone");
  await mustFail(
    "unexpectedly empty duplicate scan",
    ["duplicates", "--pattern", "**/*.quality-never"],
    "no files",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
  await rm(entry, { force: true });
  await rm(javascript, { force: true });
  await rm(site, { force: true });
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
