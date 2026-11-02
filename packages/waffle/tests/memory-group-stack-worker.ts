import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";
import { createGroupMember } from "../group/member.js";
import type { MemoryGroupMemberRequest } from "../group/protocol.js";
import { instantiateLinkPlan, prepareLinkPlan, type LinkPlanSource } from "../link/index.js";

type Request =
  | { kind: "launch"; request: MemoryGroupMemberRequest; source: LinkPlanSource; mark: number }
  | { kind: "read" }
  | { kind: "close" };

let member: ReturnType<typeof createGroupMember> | undefined;
let linked: ReturnType<typeof instantiateLinkPlan> | undefined;
let stack: { memory: WebAssembly.Memory; low: number; high: number; pointer: number } | undefined;

function globalNumber(value: WebAssembly.ImportValue | undefined): number {
  if (!(value instanceof WebAssembly.Global) || typeof value.value !== "number")
    throw new Error("expected an actual i32 stack global");
  return value.value;
}

function observe() {
  if (!stack) throw new Error("stack has not been bound");
  return {
    low: stack.low,
    high: stack.high,
    pointer: stack.pointer,
    mark: new DataView(stack.memory.buffer).getUint32(stack.low, true),
  };
}

function close() {
  linked?.dispose();
  member?.dispose();
}

async function launch(data: Extract<Request, { kind: "launch" }>) {
  member = createGroupMember(data.request, { checkActive() {} });
  const plan = await prepareLinkPlan(data.source);
  const bindings = member.bindings(plan.entryModule);
  bindings.env.check = () => {};
  const wasi = new Wasi({
    args: [],
    env: {},
    fs: new MemFS(),
    preopens: {},
    stdout() {},
    stderr() {},
    sleep() {},
    namespaces: { env: { check() {} } },
  });
  linked = instantiateLinkPlan(plan, {
    wasi,
    coreImports: wasi.imports(plan.entryModule, bindings),
    checkActive() {},
  });
  linked.initialize();
  stack = {
    memory: data.request.memory,
    low: globalNumber(bindings["GOT.mem"].__stack_low),
    high: globalNumber(bindings["GOT.mem"].__stack_high),
    pointer: globalNumber(bindings.env.__stack_pointer),
  };
  new DataView(stack.memory.buffer).setUint32(stack.low, data.mark, true);
  self.postMessage(observe());
}

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  try {
    if (data.kind === "close") {
      close();
      self.postMessage({ closed: true });
      return;
    }
    if (data.kind === "read") {
      self.postMessage(observe());
      return;
    }
    await launch(data);
  } catch (error) {
    close();
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
