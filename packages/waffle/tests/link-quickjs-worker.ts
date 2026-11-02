import { createGroupMember } from "../group/member.js";
import type { MemoryGroupMemberRequest } from "../group/protocol.js";
import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";
import { instantiateLinkPlan, prepareLinkPlan } from "../link/index.js";
import { inspectProfile } from "../link/metadata.js";
import { sharedSource, verifiedInputs } from "./link-shared-basic512-fixture.js";

type Message =
  | {
      readonly kind: "launch";
      readonly directory: string;
      readonly request: MemoryGroupMemberRequest;
    }
  | { readonly kind: "read" }
  | { readonly kind: "close" };

let member: ReturnType<typeof createGroupMember> | undefined;
let linked: ReturnType<typeof instantiateLinkPlan> | undefined;
let wasi: Wasi | undefined;
let phase = "admission";
const unexpected: string[] = [];

function numberGlobal(value: WebAssembly.ImportValue | undefined): number {
  if (!(value instanceof WebAssembly.Global) || typeof value.value !== "number")
    throw new Error("expected an actual i32 binding");
  return value.value >>> 0;
}
function call(instance: WebAssembly.Instance, name: string): number {
  const fn = instance.exports[name];
  if (typeof fn !== "function") throw new Error(`missing ${name}`);
  return fn() >>> 0;
}
function close(): void {
  linked?.dispose();
  member?.dispose();
  wasi?.descriptors.dispose();
}
function processImports(names: readonly string[]): WebAssembly.ModuleImports {
  const namespace: WebAssembly.ModuleImports = Object.create(null);
  for (const name of names)
    namespace[name] = () => {
      unexpected.push(name);
      throw new Error(`runtime_proc.${name} called during ${phase}`);
    };
  namespace.signal = (signal: number, mode: number) => {
    if (signal !== 0 || mode !== 4) throw new Error(`unexpected signal ${signal}/${mode}`);
    return 0;
  };
  return namespace;
}

async function launch(data: Extract<Message, { kind: "launch" }>): Promise<void> {
  const input = await verifiedInputs(data.directory);
  const profile = inspectProfile(input.core, "bun-core", false);
  const plan = await prepareLinkPlan(sharedSource(input.core, input.side));
  member = createGroupMember(data.request, { checkActive() {} });
  const bindings = member.bindings(plan.entryModule);
  const proc = processImports(
    profile.functionImports
      .filter((entry) => entry.module === "runtime_proc")
      .map((entry) => entry.name),
  );
  wasi = new Wasi({
    args: [],
    env: {},
    fs: new MemFS(),
    preopens: {},
    stdout() {},
    stderr() {},
    sleep() {},
    namespaces: { runtime_shm: member.imports, runtime_proc: proc },
  });
  phase = "core-memory";
  linked = instantiateLinkPlan(plan, {
    wasi,
    coreImports: wasi.imports(plan.entryModule, bindings),
    checkActive() {},
  });
  if (linked.libraries.length !== 0) throw new Error("library escaped before initialize");
  const stackLow = numberGlobal(bindings["GOT.mem"].__stack_low);
  const stackHigh = numberGlobal(bindings["GOT.mem"].__stack_high);
  const stackPointer = numberGlobal(bindings.env.__stack_pointer);
  const slotPointer = call(linked.entry, "bun_wasm_host_slots");
  const errnoPointer = call(linked.entry, "errno_location");
  const coreBase = numberGlobal(bindings.env.__memory_base);
  const view = new DataView(data.request.memory.buffer);
  const header = [view.getUint32(slotPointer, true), view.getUint32(slotPointer + 4, true)];
  const observation = {
    header,
    slotPointer,
    coreBase,
    coreSize: profile.memory!.memorySize,
    errnoPointer,
    stackLow,
    stackHigh,
    stackPointer,
  };
  self.postMessage({ kind: "core-memory", ...observation });
  phase = "constructors-and-side";
  linked.initialize();
  const library = linked.libraries[0];
  if (!library) throw new Error("library did not publish after initialize");
  const ctorValue = call(library.instance, "quickjs_ctor_value");
  linked.initialize();
  const secondCtorValue = call(library.instance, "quickjs_ctor_value");
  self.postMessage({
    kind: "ready",
    ...observation,
    unexpected,
    memoryBase: library.memoryBase,
    memorySize: library.memorySize,
    ctorValue,
    secondCtorValue,
  });
}

self.onmessage = async ({ data }: MessageEvent<Message>) => {
  try {
    if (data.kind === "close") {
      close();
      self.postMessage({ kind: "closed" });
      return;
    }
    if (data.kind === "read") {
      if (!linked) throw new Error("missing group");
      self.postMessage({ kind: "reread", errnoPointer: call(linked.entry, "errno_location") });
      return;
    }
    await launch(data);
  } catch (error) {
    close();
    self.postMessage({
      kind: "error",
      phase,
      unexpected,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
