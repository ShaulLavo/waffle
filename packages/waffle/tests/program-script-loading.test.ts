import { afterEach, expect, test } from "bun:test";
import { createGitPackage } from "../../git/src/program.js";
import { createRuntime, type Runtime, type GuestLauncher } from "../index.js";
import { DescriptorTable } from "../core/descriptors.js";
import { createProgramShell } from "./fixtures/program-shell.js";
import { wasiCat } from "./fixtures/wasi-cat.js";

let runtime: Runtime | undefined;
let tables: DescriptorTable[] = [];
let release = () => {};
afterEach(async () => {
  release();
  await runtime?.dispose();
  runtime = undefined;
  for (const table of tables) table.dispose();
  tables = [];
});
async function create(launcher?: GuestLauncher) {
  const owner = createRuntime({
    programs: { launcher },
    filesystem: { mode: "memory", workerURL: new URL("../browser/fs-worker.ts", import.meta.url) },
  });
  runtime = owner;
  let loads = 0;
  await owner.programs.onDemand({
    name: "explicit-interpreter",
    programs: [
      {
        path: "/bin/interpreter",
        source: async () => {
          loads++;
          return wasiCat();
        },
      },
    ],
  });
  return { owner, loads: () => loads };
}
async function rejects(pending: Promise<unknown>) {
  return pending.then(
    () => {
      throw new Error("expected rejection");
    },
    (error: unknown) => error,
  );
}

test("script preload and aliases prepare once and use the existing interpreter adapter", async () => {
  const { owner, loads } = await create();
  let prepares = 0;
  const git = createGitPackage({
    interpreter: "/bin/interpreter",
    source: async () => {
      prepares++;
      return "script payload\n";
    },
  });
  await owner.programs.onDemand(git);
  const shell = await createProgramShell(owner, tables);
  expect(await shell.access("/bin/git")).toBe(0);
  expect(prepares).toBe(0);
  expect(loads()).toBe(0);
  await Promise.all([owner.programs.preload("git"), owner.programs.preload("/bin/git")]);
  expect(owner.programs.get("git")?.state.kind).toBe("loaded");
  expect(loads()).toBe(1);
  const exits = await Promise.all([
    shell.exec("/usr/bin/git", ["git"]),
    shell.exec("/bin/git", ["git"]),
  ]);
  expect(exits).toMatchObject([
    { kind: "exited", code: 0 },
    { kind: "exited", code: 0 },
  ]);
  expect(shell.output.join("")).toBe("#!/bin/interpreter\nscript payload\n".repeat(2));
  expect(prepares).toBe(1);
  await owner.programs.get("git")!.remove();
  expect(await owner.filesystem.lookup("/usr/bin/git")).toBeUndefined();
  expect(await owner.filesystem.lookup("/bin/git")).toBeUndefined();
  expect(await shell.access("/bin/interpreter")).toBe(0);
});

test("removing a script during preparation waits and never recreates a marker", async () => {
  const { owner, loads } = await create();
  const gate = new Promise<void>((yes) => {
    release = yes;
  });
  let preparing = false;
  const git = createGitPackage({
    interpreter: "/bin/interpreter",
    source: async () => {
      preparing = true;
      await gate;
      return "script payload";
    },
  });
  await owner.programs.onDemand(git);
  const loading = rejects(owner.programs.preload("git"));
  while (!preparing) await Bun.sleep(1);
  const removal = owner.programs.get("git")!.remove();
  release();
  expect(await loading).toBeInstanceOf(Error);
  await removal;
  expect(await owner.filesystem.lookup("/bin/git")).toBeUndefined();
  expect(loads()).toBe(0);
});

test("script preparation rejects a replaced marker and preserves the writer's file", async () => {
  const { owner } = await create();
  const git = createGitPackage({
    interpreter: "/bin/interpreter",
    source: async () => "script payload",
  });
  await owner.programs.onDemand(git);
  await owner.filesystem.writeFile("/usr/bin/git", "user data");
  expect(await rejects(owner.programs.preload("git"))).toBeInstanceOf(Error);
  await owner.programs.get("git")!.remove();
  expect(new TextDecoder().decode(await owner.filesystem.readFile("/usr/bin/git"))).toBe(
    "user data",
  );
});

test("declared script chains retain all package lifetimes and complete every load state", async () => {
  let argv: readonly string[] = [];
  const { owner } = await create((context) => {
    argv = context.request.argv.slice();
    expect(context.module).toBeInstanceOf(WebAssembly.Module);
    context.started();
    context.exit(0);
    return { terminate() {} };
  });
  const inner = {
    name: "inner",
    programs: [
      {
        path: "/bin/inner",
        script: { interpreter: "/bin/interpreter", source: async () => "inner script\n" },
      },
    ],
  };
  const git = createGitPackage({ interpreter: "/bin/inner", source: async () => "outer script\n" });
  await owner.programs.onDemand(inner, git);
  await owner.programs.preload("git");
  expect(owner.programs.get("inner")?.state.kind).toBe("loaded");
  expect(owner.programs.get("git")?.state.kind).toBe("loaded");
  const shell = await createProgramShell(owner, tables);
  expect(await shell.exec("/bin/git", ["git"])).toMatchObject({ kind: "exited", code: 0 });
  expect(argv).toEqual(["/bin/interpreter", "/bin/inner", "/bin/git"]);
  await owner.programs.get("inner")!.remove();
  await owner.programs.get("git")!.remove();
});

test("an outer script preparation failure retires already prepared interpreter-script activity", async () => {
  const { owner } = await create();
  const inner = {
    name: "inner",
    programs: [
      {
        path: "/bin/inner",
        script: { interpreter: "/bin/interpreter", source: async () => "inner script\n" },
      },
    ],
  };
  const git = createGitPackage({
    interpreter: "/bin/inner",
    source: async () => {
      throw new Error("outer source failed");
    },
  });
  await owner.programs.onDemand(inner, git);
  expect(await rejects(owner.programs.preload("git"))).toBeInstanceOf(Error);
  expect(owner.programs.get("inner")?.state.kind).toBe("error");
  await owner.programs.get("inner")!.remove();
  await owner.programs.get("git")!.remove();
});
