import { afterEach, expect, spyOn, test } from "bun:test";
import { base, basePackages } from "../../base/src/index.js";
import { createPythonPackage } from "../../python/src/index.js";
import { createGitPackage } from "../../git/src/program.js";
import { createRuntime, type Runtime } from "../index.js";
import type { ProgramPackage } from "../programs/index.js";
import { DescriptorTable } from "../core/descriptors.js";
import { createProgramShell } from "./fixtures/program-shell.js";
import { wasiCat } from "./fixtures/wasi-cat.js";

let runtime: Runtime | undefined;
let tables: DescriptorTable[] = [];
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  for (const table of tables) table.dispose();
  tables = [];
});

for (const family of basePackages.concat([base])) {
  test(`${family.name} positive, alias and missing metadata queries do no program work`, async () => {
    await metadataOnly(() => family);
  });
}

test("optional Python metadata never prepares payloads or loads its interpreter", async () => {
  await metadataOnly((owner, counts) =>
    createPythonPackage(owner, {
      source: async () => {
        counts.source++;
        return wasiCat();
      },
      payload: () => {
        counts.prepare++;
        throw new Error("payload must stay lazy");
      },
    }),
  );
});

test("optional Git metadata requires an explicitly registered interpreter and never fetches either payload", async () => {
  await metadataOnly(async (owner, counts) => {
    owner.registerAdapter("explicit:bun", () => {
      counts.launch++;
      throw new Error("must not launch");
    });
    await owner.filesystem.writeFile("/bin/bun", "explicit interpreter\n");
    owner.registerProgram("/bin/bun", {
      adapter: "explicit:bun",
      source: async () => {
        counts.source++;
        return wasiCat();
      },
    });
    return createGitPackage({
      interpreter: "/bin/bun",
      source: async () => {
        counts.prepare++;
        return "process.exit(0)";
      },
    });
  });
});

test("Git without its declared interpreter stays unavailable without creating or fetching one", async () => {
  await metadataOnly(() => createGitPackage({ interpreter: "/bin/not-installed" }), -44);
});

interface Counts {
  source: number;
  prepare: number;
  launch: number;
}
async function metadataOnly(
  build: (owner: Runtime, counts: Counts) => ProgramPackage | Promise<ProgramPackage>,
  expected = 0,
): Promise<void> {
  const counts: Counts = { source: 0, prepare: 0, launch: 0 };
  const fetching = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("metadata fetched payload"),
  );
  const compiling = spyOn(WebAssembly, "compile");
  const streaming = spyOn(WebAssembly, "compileStreaming");
  const instantiating = spyOn(WebAssembly, "instantiate");
  const previousWorker = globalThis.Worker;
  let workers = 0;
  try {
    const owner = createRuntime({
      filesystem: {
        mode: "memory",
        workerURL: new URL("../browser/fs-worker.ts", import.meta.url),
      },
      programs: {
        launcher: () => {
          counts.launch++;
          throw new Error("metadata launched worker");
        },
      },
    });
    runtime = owner;
    globalThis.Worker = class extends previousWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        workers++;
        super(...args);
      }
    };
    const pkg = await build(owner, counts);
    await owner.programs.onDemand(pkg);
    const shell = await createProgramShell(owner, tables);
    for (const program of pkg.programs) {
      expect(await shell.access(program.path)).toBe(expected);
      for (const alias of program.aliases ?? []) expect(await shell.access(alias)).toBe(expected);
      expect(await shell.access(`${program.path}-missing`)).toBe(-44);
    }
    expect(fetching.mock.calls).toHaveLength(0);
    expect(compiling.mock.calls).toHaveLength(0);
    expect(streaming.mock.calls).toHaveLength(0);
    expect(instantiating.mock.calls).toHaveLength(0);
    expect(workers).toBe(0);
    expect(counts).toEqual({ source: 0, prepare: 0, launch: 0 });
    expect(owner.programs.status().every((entry) => entry.state.kind === "registered")).toBe(true);
  } finally {
    fetching.mockRestore();
    compiling.mockRestore();
    streaming.mockRestore();
    instantiating.mockRestore();
    globalThis.Worker = previousWorker;
  }
}
