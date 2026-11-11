import { Wasi } from "../../core/wasi.js";
import { MemFS } from "../../fs/memory.js";
import { createGroupMember } from "../../group/member.js";
import type { MemoryGroupMemberRequest } from "../../group/protocol.js";
import { instantiateLinkPlan, adoptLinkPlan, type SharedLinkPlan } from "../../link/index.js";

const nativeCompile = WebAssembly.compile;
let compileCalls = 0;
WebAssembly.compile = (bytes) => {
  compileCalls++;
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer))
    throw new Error("expected private Uint8Array compiler input");
  return nativeCompile(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
};

let linked: ReturnType<typeof instantiateLinkPlan> | undefined;
let member: ReturnType<typeof createGroupMember> | undefined;
let wasi: Wasi | undefined;
let observation: object | undefined;
function numberGlobal(value: WebAssembly.ImportValue | undefined): number {
  if (!(value instanceof WebAssembly.Global) || typeof value.value !== "number")
    throw new Error("missing i32 global");
  return value.value;
}
function read(instance: WebAssembly.Instance): number {
  const fn = instance.exports.read;
  if (typeof fn !== "function") throw new Error("missing read");
  return fn();
}
function observe() {
  if (!linked) throw new Error("missing group");
  return {
    ...observation,
    coreMark: read(linked.entry),
    sideMark: read(linked.libraries[0]!.instance),
  };
}
async function launch(request: MemoryGroupMemberRequest, mark: number, image: SharedLinkPlan) {
  await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const compileControl = compileCalls;
  compileCalls = 0;
  const plan = adoptLinkPlan(image);
  Reflect.set(image, "reserve", "absent");
  Reflect.get(image, "core").initializeMemory.length = 0;
  member = createGroupMember(request, { checkActive() {} });
  const bindings = member.bindings(plan.entryModule);
  bindings.env.trace = () => {};
  bindings.env.check = () => {};
  wasi = new Wasi({
    args: [],
    env: {},
    fs: new MemFS(),
    preopens: {},
    stdout() {},
    stderr() {},
    sleep() {},
  });
  linked = instantiateLinkPlan(plan, {
    wasi,
    coreImports: wasi.imports(plan.entryModule, bindings),
    checkActive() {},
  });
  linked.initialize();
  const side = linked.libraries[0]!;
  const coreTls = numberGlobal(linked.entry.exports.tls);
  const sideTls = numberGlobal(side.instance.exports.tls);
  observation = {
    coreTls,
    sideTls,
    compileCalls,
    compileControl,
    frozen:
      Object.isFrozen(plan.shared) &&
      Object.isFrozen(Reflect.get(plan.shared, "core").initializeMemory),
    coreBase: numberGlobal(bindings.env.__memory_base),
    sideBase: side.memoryBase,
    low: numberGlobal(bindings["GOT.mem"].__stack_low),
    high: numberGlobal(bindings["GOT.mem"].__stack_high),
    pointer: numberGlobal(bindings.env.__stack_pointer),
    sameStack: side.instance.exports.stack === linked.entry.exports.stack,
    memoryCoreMark: read(linked.entry),
    memorySideMark: read(side.instance),
  };
  const view = new DataView(request.memory.buffer);
  view.setUint32(coreTls, mark, true);
  view.setUint32(sideTls, mark + 1, true);
  self.postMessage(observe());
}
self.onmessage = async ({
  data,
}: MessageEvent<
  | { kind: "launch"; request: MemoryGroupMemberRequest; mark: number; linkPlan: SharedLinkPlan }
  | { kind: "read" }
  | { kind: "close" }
>) => {
  try {
    if (data.kind === "close") {
      linked?.dispose();
      member?.dispose();
      wasi?.descriptors.dispose();
      self.postMessage({ closed: true });
      return;
    }
    if (data.kind === "read") {
      self.postMessage(observe());
      return;
    }
    await launch(data.request, data.mark, data.linkPlan);
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
