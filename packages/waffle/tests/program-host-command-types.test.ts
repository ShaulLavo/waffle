import { expect, test } from "bun:test";
import type { PackageProgram } from "../programs/index.js";
import type { ProgramDefinition } from "../runtime.js";
import type { CommandProcessContext, ProcessContext } from "../proc/types.js";
import type { HostCommandDefinition } from "../proc/command.js";

test("host-command variants keep module admission and launcher types distinct", () => {
  const checkTypes = () => {
    const command: HostCommandDefinition = { load: async () => async () => 0 };
    // @ts-expect-error Commands cannot carry Wasm assets.
    const wasm: PackageProgram = { path: "/command", command, wasm: new URL("file:///guest.wasm") };
    // @ts-expect-error Commands cannot carry a byte source.
    const source: PackageProgram = {
      path: "/command",
      command,
      source: async () => new Uint8Array(),
    };
    // @ts-expect-error Commands cannot carry script interpreters.
    const script: PackageProgram = {
      path: "/command",
      command,
      script: { interpreter: "/bin/guest", source: async () => "" },
    };
    // @ts-expect-error Commands cannot select a module launcher.
    const launch: PackageProgram = {
      path: "/command",
      command,
      launch: () => ({ terminate() {} }),
    };
    // @ts-expect-error Commands cannot carry an adapter.
    const adapter: ProgramDefinition = { command, adapter: "guest" };
    // @ts-expect-error Commands cannot carry a compiled module.
    const module: ProgramDefinition = { command, module: new WebAssembly.Module(new Uint8Array()) };
    const withoutModule = {};
    // @ts-expect-error Ordinary module contexts still require their module.
    const guest: ProcessContext = withoutModule;
    const inspect = (context: CommandProcessContext) => {
      // @ts-expect-error Module-less contexts do not promise a module.
      return context.module;
    };
    void [wasm, source, script, launch, adapter, module, guest, inspect];
  };
  expect(typeof checkTypes).toBe("function");
});
