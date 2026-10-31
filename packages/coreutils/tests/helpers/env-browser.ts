import { createRuntime, type Runtime } from "waffle";
import { createShell, type Shell } from "../../src/shell.ts";
import { installEnv } from "../../src/utilities/env.ts";
import { type UtilityInstallation } from "../../src/utilities/install.ts";

const decoder = new TextDecoder();
type Fixture = {
  runtime: Runtime;
  active: Shell | undefined;
  installations: UtilityInstallation[];
  loads: string[];
};

async function dispose(state: Fixture) {
  await state.active?.dispose();
  for (const installation of state.installations) await installation.dispose();
  await state.runtime.dispose();
}

async function fixture() {
  const state: Fixture = {
    runtime: createRuntime({
      filesystem: { mode: "memory", workerURL: "/fs-worker.js" },
    }),
    active: undefined,
    installations: [],
    loads: [],
  };
  const source = (name: string, file: string) => async () => {
    state.loads.push(name);
    const response = await fetch(`/${file}.wasm`);
    if (!response.ok) throw new Error(`env fixture fetch failed: ${file}`);
    return new Uint8Array(await response.arrayBuffer());
  };
  try {
    await state.runtime.filesystem.mkdirp("/tmp/spec");
    state.installations.push(
      await installEnv(state.runtime, {
        source: source("env", "env"),
        workerUrl: "/shell-worker.js",
      }),
    );
    return state;
  } catch (error) {
    await dispose(state);
    throw error;
  }
}

async function run(state: Fixture, script: string, cwd = "/") {
  const stdoutDecoder = new TextDecoder();
  let stdout = "";
  const shell = await createShell({
    runtime: state.runtime,
    workerUrl: "/shell-worker.js",
    wasmUrl: "/shell-runtime.wasm",
    cwd,
    env: { PATH: "/bin", A: "old" },
    script: `{ ${script}; } 2>/tmp/diagnostic`,
  });
  state.active = shell;
  const drain = () => {
    stdout += stdoutDecoder.decode(shell.terminal.drain(), { stream: true });
  };
  const timer = setInterval(drain, 2);
  try {
    const result = await shell.done;
    drain();
    return {
      status: result.code,
      stdout: stdout + stdoutDecoder.decode(),
      stderr: decoder.decode(await state.runtime.filesystem.readFile("/tmp/diagnostic")),
    };
  } finally {
    clearInterval(timer);
    await shell.dispose();
    state.active = undefined;
  }
}

async function check(script: string, cwd = "/") {
  const state = await fixture();
  try {
    return await run(state, script, cwd);
  } finally {
    await dispose(state);
  }
}

async function lifecycle() {
  const state = await fixture();
  try {
    const before = state.loads.slice();
    const first = await run(state, "env -i A=one");
    const second = await run(state, "env -i -0 B=two");
    const after = state.loads.slice();
    for (const installation of state.installations) await installation.dispose();
    await state.runtime.filesystem.writeFile("/owner-alive", "alive");
    return {
      before,
      after,
      first,
      second,
      ownerAlive: decoder.decode(await state.runtime.filesystem.readFile("/owner-alive")),
      removed: !(await state.runtime.filesystem.lookup("/bin/env")),
    };
  } finally {
    await dispose(state);
  }
}

declare global {
  interface Window {
    envTests: { check: typeof check; lifecycle: typeof lifecycle };
  }
}
window.envTests = { check, lifecycle };
