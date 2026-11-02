import { Wasi } from "../../core/wasi.js";
import { MemFS } from "../../fs/memory.js";
import { createGroupMember } from "../../group/member.js";
import type { MemoryGroupMemberRequest } from "../../group/protocol.js";
import { instantiateLinkPlan, prepareLinkPlan } from "../../link/index.js";
import { source } from "./link-initialization.js";

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
async function launch(request: MemoryGroupMemberRequest, mark: number) {
  const plan = await prepareLinkPlan(source(true, true));
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
  | { kind: "launch"; request: MemoryGroupMemberRequest; mark: number }
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
    await launch(data.request, data.mark);
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
