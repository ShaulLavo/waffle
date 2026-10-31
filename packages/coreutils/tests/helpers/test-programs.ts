// Original acceptance composition. Test guests use the same adapter and Runtime as the shell.
import type { Runtime } from "waffle";
import { markStartup, type StartupObserver } from "../../src/runtime/startup-diagnostics";
import { registerShell } from "../../src/runtime/shell-host";

export async function registerTestPrograms(
  runtime: Runtime,
  signal?: AbortSignal,
  onStartupStage?: StartupObserver,
): Promise<void> {
  signal?.throwIfAborted();
  // Register the existing shell adapter without starting another shell, worker, or Runtime.
  registerShell(runtime, { runtime, onStartupStage });
  const load = async (name: "test-guest" | "test-spin") => {
    const url = new URL(`programs/${name}.wasm`, document.baseURI);
    markStartup(onStartupStage, `${name}-fetch-requested`);
    const response = await fetch(url, { signal });
    markStartup(onStartupStage, `${name}-fetch-resolved`);
    if (!response.ok)
      throw new Error(`Test guest fetch failed: ${url.pathname} (${response.status})`);
    markStartup(onStartupStage, `${name}-body-requested`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    markStartup(onStartupStage, `${name}-body-resolved`);
    return bytes;
  };
  markStartup(onStartupStage, "test-guests-fetch-requested");
  const [guestBytes, spinBytes] = await Promise.all([load("test-guest"), load("test-spin")]);
  markStartup(onStartupStage, "test-guests-fetch-resolved");
  signal?.throwIfAborted();
  markStartup(onStartupStage, "test-guest-compile-requested");
  const guest = await WebAssembly.compile(guestBytes);
  markStartup(onStartupStage, "test-guest-compile-resolved");
  signal?.throwIfAborted();
  markStartup(onStartupStage, "test-bin-mkdir-requested");
  await runtime.filesystem.mkdirp("/bin");
  markStartup(onStartupStage, "test-bin-mkdir-resolved");
  signal?.throwIfAborted();
  markStartup(onStartupStage, "test-programs-mkdir-requested");
  await runtime.filesystem.mkdirp("/programs");
  markStartup(onStartupStage, "test-programs-mkdir-resolved");
  // Filesystem visibility belongs to this caller, not registration. Bare commands
  // reach /bin through the shell's PATH search, never a registry-only name alias.
  await registerGuest(
    runtime,
    "test-guest",
    {
      adapter: "bash-web:preview1",
      module: guest,
      cooperative: true,
    },
    signal,
    onStartupStage,
  );
  // The separate spin guest intentionally has no cooperative/runtime_proc imports.
  // Waffle admits and instruments its source bytes; no hand-built interrupt shim is used.
  await registerGuest(
    runtime,
    "test-spin",
    {
      adapter: "bash-web:preview1",
      source: spinBytes,
    },
    signal,
    onStartupStage,
  );
  // Original empty core-Wasm module: valid at registration, but lacks _start
  // and memory. The real worker must report asynchronous START_FAILED/ENOEXEC.
  signal?.throwIfAborted();
  markStartup(onStartupStage, "test-start-failure-bin-write-requested");
  await runtime.filesystem.writeFile("/bin/test-start-failure", new Uint8Array());
  markStartup(onStartupStage, "test-start-failure-bin-write-resolved");
  signal?.throwIfAborted();
  runtime.registerProgram("/bin/test-start-failure", {
    adapter: "bash-web:preview1",
    module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
    cooperative: true,
  });
  // Metadata succeeds, but the real registry rejects loading before the adapter can run.
  signal?.throwIfAborted();
  markStartup(onStartupStage, "test-lazy-start-failure-bin-write-requested");
  await runtime.filesystem.writeFile("/bin/test-lazy-start-failure", new Uint8Array());
  markStartup(onStartupStage, "test-lazy-start-failure-bin-write-resolved");
  signal?.throwIfAborted();
  runtime.registerProgram("/bin/test-lazy-start-failure", {
    adapter: "bash-web:preview1",
    module() {
      throw new WebAssembly.CompileError("review loader failure");
    },
    cooperative: true,
  });
  signal?.throwIfAborted();
  markStartup(onStartupStage, "test-filesystem-drain-requested");
  await runtime.filesystem.drain();
  markStartup(onStartupStage, "test-filesystem-drain-resolved");
}

async function registerGuest(
  runtime: Runtime,
  guestName: "test-guest" | "test-spin",
  program: Parameters<Runtime["registerProgram"]>[1],
  signal?: AbortSignal,
  onStartupStage?: StartupObserver,
): Promise<void> {
  for (const path of [`/bin/${guestName}`, `/programs/${guestName}.wasm`]) {
    signal?.throwIfAborted();
    const stage = path.startsWith("/bin/")
      ? (`${guestName}-bin-write` as const)
      : (`${guestName}-program-write` as const);
    markStartup(onStartupStage, `${stage}-requested`);
    await runtime.filesystem.writeFile(path, new Uint8Array());
    markStartup(onStartupStage, `${stage}-resolved`);
    signal?.throwIfAborted();
    runtime.registerProgram(path, program);
  }
}
