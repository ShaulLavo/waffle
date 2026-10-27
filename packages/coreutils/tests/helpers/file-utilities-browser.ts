import { createRuntime, type Runtime } from "waffle";
import { createShell, type Shell } from "../../src/shell.ts";
import { installTouch } from "../../src/utilities/touch.ts";
import { installRm } from "../../src/utilities/rm.ts";
import { installCp } from "../../src/utilities/cp.ts";
import { installMv } from "../../src/utilities/mv.ts";
import { fileUtilityEnvironment, fileUtilityNames } from "./file-utility-cases.ts";
import { fileUtilityTree, seedFileUtilityTree } from "./file-utility-filesystem.ts";

const installers = { touch: installTouch, rm: installRm, cp: installCp, mv: installMv };

type Fixture = {
  runtime: Runtime;
  active: Shell | undefined;
  loaded: string[];
  installations: Awaited<ReturnType<typeof installTouch>>[];
  childLaunched: () => void;
};

async function dispose(state: Fixture) {
  await state.active?.dispose();
  await Promise.all(state.installations.map((installation) => installation.dispose()));
  await state.runtime.dispose();
}

async function install(state: Fixture, name: (typeof fileUtilityNames)[number]) {
  state.installations.push(
    await installers[name](state.runtime, {
      workerUrl: "/shell-worker.js",
      source: async () => {
        state.loaded.push(name);
        const response = await fetch(`/${name}.wasm`);
        if (!response.ok) throw new Error(`Guest fetch failed: ${name}`);
        return new Uint8Array(await response.arrayBuffer());
      },
    }),
  );
}

async function fixture() {
  const state: Fixture = {
    runtime: createRuntime({
      filesystem: { mode: "memory", workerURL: "/fs-worker.js" },
      onProcessAdmission(event) {
        if (event.stage === "launched") state.childLaunched();
      },
    }),
    active: undefined,
    loaded: [],
    installations: [],
    childLaunched() {},
  };
  try {
    await seedFileUtilityTree(state.runtime);
    for (const name of fileUtilityNames) await install(state, name);
    return state;
  } catch (error) {
    await dispose(state);
    throw error;
  }
}

async function run(
  state: Fixture,
  script: string,
  interaction: "none" | "interrupt" | "decline" = "none",
) {
  const admission = Promise.withResolvers<void>();
  state.childLaunched = admission.resolve;
  const output: number[] = [];
  const shell = await createShell({
    runtime: state.runtime,
    workerUrl: "/shell-worker.js",
    wasmUrl: "/shell-runtime.wasm",
    cwd: "/tmp/spec",
    env: fileUtilityEnvironment,
    script: `{ ${script}; } 2>/tmp/diagnostic`,
  });
  state.active = shell;
  const drain = () => {
    for (const byte of shell.terminal.drain()) output.push(byte);
  };
  const timer = setInterval(drain, 2);
  try {
    if (interaction !== "none") await admission.promise;
    if (interaction === "interrupt") shell.interrupt();
    if (interaction === "decline") shell.terminal.send(new TextEncoder().encode("n\n"));
    const result = await shell.done;
    drain();
    return {
      status: result.code,
      stdout: output,
      stderr: ((await state.runtime.filesystem.readFile("/tmp/diagnostic"))?.length ?? 0) > 0,
      tree: await fileUtilityTree(state.runtime),
    };
  } finally {
    clearInterval(timer);
    await shell.dispose();
    state.active = undefined;
  }
}

async function check(script: string) {
  const state = await fixture();
  try {
    return await run(state, script);
  } finally {
    await dispose(state);
  }
}

async function lifecycle() {
  const state = await fixture();
  try {
    const before = state.loaded.slice();
    await run(state, "touch new");
    await run(state, "touch again");
    const afterTouch = state.loaded.slice();
    await run(state, "cp input copied; mv copied moved; rm moved");
    const afterAll = state.loaded.slice();
    await Promise.all(state.installations.map((installation) => installation.dispose()));
    const missing = await run(state, "touch absent");
    await state.runtime.filesystem.writeFile("/tmp/owner-alive", "alive");
    return {
      before,
      afterTouch,
      afterAll,
      missing: missing.status,
      ownerAlive: new TextDecoder().decode(
        await state.runtime.filesystem.readFile("/tmp/owner-alive"),
      ),
      removed: await Promise.all(
        fileUtilityNames.map(
          async (name) => !(await state.runtime.filesystem.lookup(`/bin/${name}`)),
        ),
      ),
    };
  } finally {
    await dispose(state);
  }
}

async function cancel() {
  const state = await fixture();
  try {
    const cancelled = await run(state, "cp -i input existing", "interrupt");
    const after = await run(state, "touch after-cancel");
    return {
      status: cancelled.status,
      after: after.status,
      created: Boolean(await state.runtime.filesystem.lookup("/tmp/spec/after-cancel")),
    };
  } finally {
    await dispose(state);
  }
}

async function metadataGap() {
  const state = await fixture();
  try {
    const actual = await run(state, "mv input existing", "decline");
    const diagnostic = new TextDecoder().decode(
      await state.runtime.filesystem.readFile("/tmp/diagnostic"),
    );
    return { actual, diagnostic };
  } finally {
    await dispose(state);
  }
}

declare global {
  interface Window {
    fileUtilities: {
      check: typeof check;
      lifecycle: typeof lifecycle;
      cancel: typeof cancel;
      metadataGap: typeof metadataGap;
    };
  }
}
window.fileUtilities = { check, lifecycle, cancel, metadataGap };
