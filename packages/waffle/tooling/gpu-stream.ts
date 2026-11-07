import { createHash } from "node:crypto";
import { resolve } from "node:path";
import selection from "../browser/gpu/stream.json" with { type: "json" };
import {
  fields,
  list,
  record,
  text,
  uint,
  type CallLayout,
  type Field,
  type Lowering,
  type Result,
  type WireTables,
} from "./gpu-stream-model.ts";

const packageRoot = resolve(import.meta.dir, "..");
const schemaPath = "browser/gpu/upstream/webgpu.yml";
const licensePath = "browser/gpu/upstream/LICENSE";
const outputs = ["browser/gpu/generated/tables.ts", "tests/fixtures/gpu/waffle_gpu_stream.h"];
const fixedInputs = [
  schemaPath,
  licensePath,
  "browser/gpu/upstream/webgpu.h",
  "browser/gpu/stream.json",
  "tooling/gpu-stream.ts",
  "tooling/gpu-stream-model.ts",
  "tooling/gpu-stream-layout.ts",
  "tests/fixtures/gpu/expected.json",
  "tests/fixtures/gpu/enums.json",
  "tests/fixtures/gpu/scene-expected.json",
  "tests/fixtures/gpu/compute-expected.json",
  "tests/fixtures/gpu/bundle-query-expected.json",
  "tests/fixtures/gpu/copy-draw-expected.json",
  "tests/fixtures/gpu/label-expected.json",
  "tests/fixtures/gpu/async-expected.json",
];

export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function named(value: unknown): Map<string, Record<string, unknown>> {
  return new Map(
    list(value).map((item) => {
      const entry = record(item);
      return [text(entry.name), entry];
    }),
  );
}

function unique(values: number[], retired: readonly number[], max: number): void {
  const seen = new Set(retired);
  if (seen.size !== retired.length || retired.some((value) => uint(value, max) === 0))
    throw new Error("Duplicate or padding retired value");
  for (const value of values) {
    if (uint(value, max) === 0 || seen.has(value))
      throw new Error(`Duplicate or retired value ${value}`);
    seen.add(value);
  }
}

function result(value: unknown): Result {
  const entry = record(value);
  if (entry.kind === "void") return { kind: "void" };
  if (entry.kind === "scalar") return { kind: "scalar", type: text(entry.type) };
  if (entry.kind !== "handle") throw new Error("Missing result kind");
  const source = entry.source;
  if (source !== "return" && source !== "callback" && source !== "output")
    throw new Error("Bad handle source");
  return { kind: "handle", object: text(entry.object), source };
}

function lowering(value: unknown): Lowering {
  const entry = record(value);
  switch (entry.kind) {
    case "label":
      if (entry.target === "native" || entry.target === "surface-reference")
        return { kind: entry.kind, target: entry.target };
      break;
    case "query":
      if (
        entry.adapter === "info" ||
        entry.adapter === "features" ||
        entry.adapter === "limits" ||
        entry.adapter === "has-feature" ||
        entry.adapter === "wgsl-features" ||
        entry.adapter === "has-wgsl-feature"
      )
        return { kind: "query", adapter: entry.adapter };
      break;
    case "async":
      if (
        entry.member === "mapAsync" ||
        entry.member === "getCompilationInfo" ||
        entry.member === "onSubmittedWorkDone"
      )
        return { kind: "async", member: entry.member };
      break;
    case "method":
      return { kind: entry.kind, member: text(entry.member) };
    case "descriptor-method":
      return {
        kind: entry.kind,
        member: text(entry.member),
        descriptor: text(entry.descriptor),
      };
    case "write-buffer":
    case "write-texture":
    case "set-immediates": {
      const span = record(entry.span);
      const size = entry.kind === "write-texture" ? "data_size" : "size";
      const member =
        entry.kind === "set-immediates"
          ? "setImmediates"
          : entry.kind === "write-buffer"
            ? "writeBuffer"
            : "writeTexture";
      if (span.pointer !== "data" || span.size !== size || entry.member !== member) break;
      return { kind: entry.kind, member, span: { pointer: "data", size } };
    }
    case "property":
      if (entry.member === "queue") return { kind: entry.kind, member: entry.member };
      break;
    case "request-adapter":
      if (entry.descriptor === "adapter-options")
        return { kind: entry.kind, descriptor: entry.descriptor };
      break;
    case "request-device":
      if (entry.descriptor === "device-descriptor")
        return { kind: entry.kind, descriptor: entry.descriptor };
      break;
    case "surface-create":
      if (entry.descriptor === "waffle-surface")
        return { kind: entry.kind, descriptor: entry.descriptor };
      break;
    case "surface-configure":
      if (entry.descriptor === "stable-frame")
        return { kind: entry.kind, descriptor: entry.descriptor };
      break;
    case "surface-acquire":
      if (entry.output === "surface_texture") return { kind: entry.kind, output: entry.output };
      break;
    case "surface-present":
      if (entry.result === "enum.status") return { kind: entry.kind, result: entry.result };
      break;
    case "shader-module":
      if (entry.descriptor === "wgsl-chain")
        return { kind: entry.kind, descriptor: entry.descriptor };
      break;
    case "render-pipeline":
      if (entry.descriptor === "auto-layout")
        return { kind: entry.kind, descriptor: entry.descriptor };
      break;
    case "error-scope":
      if (entry.member === "pushErrorScope" || entry.member === "popErrorScope")
        return { kind: entry.kind, member: entry.member };
      break;
  }
  throw new Error("Missing or unknown named lowering");
}

function field(name: string, type: string): Field {
  return { name, type, optional: false };
}

function checkResult(
  chosen: Result,
  method: Record<string, unknown>,
  callbacks: Map<string, Record<string, unknown>>,
): void {
  if (chosen.kind === "handle" && chosen.source === "output") {
    const args = fields(method.args);
    if (!args.some((arg) => arg.type === "struct.surface_texture"))
      throw new Error("Missing surface output");
    return;
  }
  if (typeof method.callback === "string") {
    const callback = callbacks.get(method.callback.replace("callback.", ""));
    if (!callback) throw new Error("Unknown callback");
    const object = fields(callback.args).find((arg) => arg.type.startsWith("object."));
    if (!object && chosen.kind === "void") return;
    if (
      chosen.kind === "handle" &&
      chosen.source === "callback" &&
      object?.type === `object.${chosen.object}`
    )
      return;
    throw new Error("Callback result mismatch");
  }
  if (!method.returns && chosen.kind === "void") return;
  const returned = record(method.returns);
  if (
    chosen.kind === "handle" &&
    chosen.source === "return" &&
    returned.type === `object.${chosen.object}`
  )
    return;
  if (chosen.kind === "scalar" && returned.type === chosen.type) return;
  throw new Error("Undeclared C return");
}

function compileCall(
  value: unknown,
  objects: Map<string, Record<string, unknown>>,
  callbacks: Map<string, Record<string, unknown>>,
  outputs: Record<string, unknown>,
): CallLayout {
  const entry = record(value);
  const name = text(entry.name);
  const receiver = text(entry.receiver);
  const method = named(objects.get(receiver)?.methods).get(name.slice(receiver.length + 1));
  if (!method || !name.startsWith(`${receiver}.`)) throw new Error(`Missing YAML call ${name}`);
  const chosen = result(entry.result);
  checkResult(chosen, method, callbacks);
  const cReturn = method.callback
    ? "struct.future"
    : method.returns
      ? text(record(method.returns).type)
      : "void";
  if (entry.cReturn !== cReturn) throw new Error("Undeclared C return type");
  const callback = callbackLayout(entry.callback, method.callback);
  const token = entry.token === null ? null : text(entry.token);
  if (
    (method.callback ||
      chosen.kind === "scalar" ||
      (chosen.kind === "handle" && chosen.source === "output")) &&
    !token
  )
    throw new Error(`Missing reply/token for ${name}`);
  const omitted = list(entry.omitted).map(text);
  if (method.callback && !omitted.includes("callback_info"))
    throw new Error("Callback pointers must be omitted");
  const context = entry.context;
  if (context !== "top" && context !== "encoder" && context !== "pass" && context !== "bundle")
    throw new Error("Bad call context");
  let prefix: Field[] =
    chosen.kind === "handle" ? [field("result", `object.${chosen.object}`)] : [];
  if (token) prefix = prefix.concat([field("token", "token")]);
  if (context === "top") prefix = prefix.concat([field("receiver", `object.${receiver}`)]);
  const args = method.args ? fields(method.args) : [];
  const adapter = lowering(entry.lowering);
  if (
    adapter.kind === "descriptor-method" &&
    !args.some((arg) => arg.name === "descriptor" && arg.type === `struct.${adapter.descriptor}`)
  )
    throw new Error("Descriptor lowering must match the pinned C argument");
  if (adapter.kind === "label") validateLabel(name, context, adapter, args);
  const output = queryOutput(entry, method, adapter, outputs, callbacks);
  const input =
    chosen.kind === "handle" && chosen.source === "output"
      ? []
      : spanArguments(args, adapter).filter(
          (arg) => !output?.fields.some((out) => out.name === arg.name),
        );
  return {
    opcode: uint(entry.opcode, 0xfff),
    name,
    receiver,
    context,
    result: chosen,
    cReturn,
    callback,
    token,
    lowering: adapter,
    omitted,
    fields: prefix.concat(input),
    ...(output ? { output } : {}),
  };
}

function queryOutput(
  entry: Record<string, unknown>,
  method: Record<string, unknown>,
  adapter: Lowering,
  outputs: Record<string, unknown>,
  callbacks: Map<string, Record<string, unknown>>,
): CallLayout["output"] {
  const mutable = (method.args ? list(method.args).map(record) : []).filter(
    (arg) => arg.pointer === "mutable",
  );
  if (adapter.kind === "async") {
    const callback = record(entry.callback);
    const source = callbacks.get(text(method.callback).slice(9));
    const signature = list(source?.args).map((arg) => {
      const value = record(arg);
      return { name: text(value.name), type: text(value.type), pointer: value.pointer ?? null };
    });
    if (JSON.stringify(callback.args) !== JSON.stringify(signature))
      throw new Error("Callback signature drift");
  }
  if (adapter.kind !== "query") {
    if (mutable.length && adapter.kind !== "surface-acquire")
      throw new Error("Undeclared mutable output");
    return undefined;
  }
  const rule = record(outputs[text(entry.name)]);
  const declared = fields(rule.fields);
  const expected = mutable.map((arg) => field(text(arg.name), text(arg.type)));
  if (method.returns) expected.unshift(field("returned", text(record(method.returns).type)));
  if (
    rule.adapter !== adapter.adapter ||
    rule.reply !== entry.token ||
    rule.payload !== `query_${entry.opcode}` ||
    JSON.stringify(declared) !== JSON.stringify(expected)
  )
    throw new Error("Mutable output/C return contract mismatch");
  if (!entry.token) throw new Error("Missing output token");
  return { adapter: adapter.adapter, payload: text(rule.payload), fields: declared };
}

function validateLabel(
  name: string,
  context: CallLayout["context"],
  adapter: Extract<Lowering, { kind: "label" }>,
  args: Field[],
): void {
  const expectedContext =
    name === "command_encoder.set_label"
      ? "encoder"
      : name === "render_pass_encoder.set_label"
        ? "pass"
        : "top";
  if (
    !name.endsWith(".set_label") ||
    context !== expectedContext ||
    adapter.target !== (name === "surface.set_label" ? "surface-reference" : "native") ||
    JSON.stringify(args) !== JSON.stringify([field("label", "string_with_default_empty")])
  )
    throw new Error("Label lowering must preserve required YAML label and receiver context");
}

function spanArguments(args: Field[], adapter: Lowering): Field[] {
  if (
    adapter.kind !== "write-buffer" &&
    adapter.kind !== "write-texture" &&
    adapter.kind !== "set-immediates"
  )
    return args;
  const index = args.findIndex((arg) => arg.name === adapter.span.pointer);
  const pointer = args[index];
  const size = args[index + 1];
  if (
    pointer?.type !== "c_void_data_ptr" ||
    size?.name !== adapter.span.size ||
    size.type !== "usize"
  )
    throw new Error("Upload span must replace the pinned C data pointer and size pair");
  return args.slice(0, index).concat([field(pointer.name, "bytes")], args.slice(index + 2));
}

function callbackLayout(value: unknown, expected: unknown): CallLayout["callback"] {
  if (expected === undefined && value === null) return null;
  const callback = record(value);
  if (
    callback.type !== expected ||
    callback.future !== "token-as-future-id" ||
    callback.delivery !== "guest-local-completion-pump"
  )
    throw new Error("Invalid callback lowering");
  const omitted = list(callback.omitted).map(text);
  if (omitted.join(",") !== "next_in_chain,mode,callback,userdata1,userdata2")
    throw new Error("Callback-info fields must remain guest-local");
  return {
    type: text(callback.type),
    future: callback.future,
    delivery: callback.delivery,
    omitted,
  };
}

function combinedFlags(value: unknown, previous: Record<string, number>): number {
  const bits = list(value)
    .map(text)
    .reduce((bits, name) => {
      const number = previous[name];
      if (number === undefined) throw new Error(`Unknown flag combination member ${name}`);
      return bits | BigInt(number);
    }, 0n);
  return uint(Number(bits));
}

function enumValues(value: Record<string, unknown>, bitflag: boolean): Record<string, number> {
  const values: Record<string, number> = {};
  for (const [index, item] of list(value.entries).entries()) {
    if (item === null) continue;
    const entry = record(item);
    if (entry.value !== undefined)
      throw new Error("Unexpected explicit enum value; inspect upstream generator");
    const ordinal = bitflag && index > 0 ? 2 ** (index - 1) : index;
    const number =
      entry.value_combination === undefined
        ? ordinal
        : combinedFlags(entry.value_combination, values);
    values[text(entry.name)] = uint(number);
  }
  return values;
}

function collectType(
  type: string,
  tables: WireTables,
  upstream: Map<string, Record<string, unknown>>,
  enums: Map<string, Record<string, unknown>>,
  bitflags: Map<string, Record<string, unknown>>,
  omitted: Record<string, unknown>,
): void {
  if (type.startsWith("array<"))
    return collectType(type.slice(6, -1), tables, upstream, enums, bitflags, omitted);
  if (type.startsWith("enum.") || type.startsWith("bitflag.")) {
    const name = type.slice(type.indexOf(".") + 1);
    const source = (type.startsWith("enum.") ? enums : bitflags).get(name);
    if (!source) throw new Error(`Unknown enum ${type}`);
    tables.enums[type] = enumValues(source, type.startsWith("bitflag."));
    return;
  }
  if (type.startsWith("object.")) return;
  if (!type.startsWith("struct.")) {
    if (
      ![
        "uint16",
        "uint32",
        "int32",
        "uint64",
        "usize",
        "float32",
        "nullable_float32",
        "float64",
        "float64_supertype",
        "bool",
        "nullable_bool",
        "nullable_string",
        "string",
        "string_with_default_empty",
        "out_string",
        "handle",
        "token",
        "bytes",
        "raw-bytes",
      ].includes(type)
    )
      throw new Error(`Unsupported wire type ${type}`);
    return;
  }
  collectStruct(type.slice(7), tables, upstream, enums, bitflags, omitted);
}

function collectStruct(
  name: string,
  tables: WireTables,
  upstream: Map<string, Record<string, unknown>>,
  enums: Map<string, Record<string, unknown>>,
  bitflags: Map<string, Record<string, unknown>>,
  omitted: Record<string, unknown>,
): void {
  if (tables.structs[name]) return;
  const source = upstream.get(name);
  if (!source) throw new Error(`Unknown struct ${name}`);
  const excluded = omitted[name] === undefined ? [] : list(omitted[name]).map(text);
  const members = fields(source.members).filter((member) => !excluded.includes(member.name));
  const chain =
    source.type === "extensible" || source.type === "extensible_callback_arg"
      ? [field("next_in_chain", `chain.${name}`)]
      : [];
  tables.structs[name] = { fields: chain.concat(members) };
  for (const member of members)
    collectType(member.type, tables, upstream, enums, bitflags, omitted);
  for (const extension of tables.chains[name] ?? [])
    collectStruct(extension.struct, tables, upstream, enums, bitflags, omitted);
}

/** Accepts untyped selection/YAML so generator-failure tests exercise the same boundary as the CLI. */
export function compileSchema(yaml: unknown, input: unknown): WireTables {
  const source = record(yaml);
  const selected = record(input);
  const calls = list(selected.calls).map((entry) =>
    compileCall(entry, named(source.objects), named(source.callbacks), record(selected.cOutput)),
  );
  const records = list(selected.records).map((value) => {
    const entry = record(value);
    const opcode = uint(entry.opcode, 0x1fff);
    if (opcode < 0x1000) throw new Error("Waffle record outside reserved range");
    return {
      name: text(entry.name),
      opcode,
      enabled: entry.enabled === true,
      fields: fields(entry.fields),
    };
  });
  unique(
    calls.map((call) => call.opcode).concat(records.map((entry) => entry.opcode)),
    list(selected.retiredOpcodes).map((value) => uint(value, 0x1fff)),
    0x1fff,
  );
  const completions = list(selected.completions).map((value) => {
    const entry = record(value);
    return { name: text(entry.name), kind: uint(entry.kind, 0xffff), fields: fields(entry.fields) };
  });
  unique(
    completions.map((entry) => entry.kind),
    list(selected.retiredCompletions).map((value) => uint(value, 0xffff)),
    0xffff,
  );
  const chains = Object.fromEntries(
    Object.entries(record(selected.chains)).map(([name, value]) => [
      name,
      list(value).map((item) => {
        const entry = record(item);
        return { sType: uint(entry.sType), struct: text(entry.struct) };
      }),
    ]),
  );
  const tables: WireTables = {
    root: { object: "instance", id: 1, generation: 1 },
    calls,
    structs: {},
    enums: {},
    browserEnums: {},
    chains,
    completions,
    records,
  };
  if (JSON.stringify(selected.root) !== JSON.stringify(tables.root))
    throw new Error("Changed reserved instance root");
  const structs = named(source.structs);
  structs.set("surface_source_waffle", {
    name: "surface_source_waffle",
    members: [field("surface_id", "uint32")],
  });
  structs.set("write_range", { members: [field("offset", "uint64"), field("data", "bytes")] });
  for (const call of calls) {
    if (call.output) structs.set(call.output.payload, { members: call.output.fields });
  }
  const enumSource = named(source.enums);
  const bitflags = named(source.bitflags);
  const omitted = record(selected.omit);
  const allFields = calls
    .flatMap((call) => call.fields)
    .concat(
      completions.flatMap((entry) => entry.fields),
      records.flatMap((entry) => entry.fields),
      calls.flatMap((entry) =>
        entry.output ? [field("payload", `struct.${entry.output.payload}`)] : [],
      ),
      calls.some((call) => call.lowering.kind === "async")
        ? [field("compilation", "struct.compilation_info")]
        : [],
    );
  for (const member of allFields)
    collectType(member.type, tables, structs, enumSource, bitflags, omitted);
  tables.enums["enum.s_type"] = enumValues(record(enumSource.get("s_type")), false);
  const output = record(record(selected.cOutput)["surface.get_current_texture"]);
  const outputFields = fields(record(structs.get("surface_texture")).members).map(
    (member) => member.name,
  );
  if (
    output.type !== "struct.surface_texture" ||
    JSON.stringify(output.fields) !== JSON.stringify(outputFields)
  )
    throw new Error("Surface output layout mismatch");
  validateSelection(tables, selected);
  return tables;
}

function validateSelection(tables: WireTables, selected: Record<string, unknown>): void {
  validateLedger(
    tables.calls
      .map((entry) => [entry.name, entry.opcode] as const)
      .concat(tables.records.map((entry) => [entry.name, entry.opcode] as const)),
    selected.opcodeLedger,
    selected.retiredOpcodes,
  );
  validateLedger(
    tables.completions.map((entry) => [entry.name, entry.kind] as const),
    selected.completionLedger,
    selected.retiredCompletions,
  );
  validateDictionaries(tables, selected);
  const objectKinds = Object.values(record(selected.objectKinds)).map((value) => uint(value));
  unique(objectKinds, [], 0xffffffff);
  if (
    JSON.stringify(tables.chains.shader_module_descriptor) !==
      JSON.stringify([{ sType: 2, struct: "shader_source_WGSL" }]) ||
    JSON.stringify(tables.chains.surface_descriptor) !==
      JSON.stringify([{ sType: 4096, struct: "surface_source_waffle" }])
  )
    throw new Error("Changed reserved triangle chain layout");
  const descriptors = record(selected.descriptors);
  for (const call of tables.calls) {
    if ("descriptor" in call.lowering && !descriptors[call.lowering.descriptor])
      throw new Error("Missing descriptor adapter");
    if (call.token && !tables.completions.some((entry) => entry.name === call.token))
      throw new Error("Missing completion");
  }
  const maps = record(selected.browserEnums);
  for (const [name, value] of Object.entries(maps)) {
    if (!tables.enums[name]) throw new Error(`Unreachable enum map ${name}`);
    tables.browserEnums[name] = browserMap(value, tables.enums[name]);
  }
  for (const name of Object.keys(tables.enums)) {
    if (!tables.browserEnums[name]) throw new Error(`Missing explicit enum lowering ${name}`);
  }
  const reserved = ["release", "encode", "render-bundle", "buffer-unmap-writes", "chunk"];
  for (const [index, name] of reserved.entries()) {
    if (!tables.records.some((entry) => entry.name === name && entry.opcode === 0x1000 + index))
      throw new Error("Changed reserved Waffle opcode");
  }
  const names = tables.calls
    .map((call) => call.name)
    .concat(tables.records.map((entry) => entry.name));
  if (new Set(names).size !== names.length) throw new Error("Duplicate call/record name");
}

function validateLedger(
  active: readonly (readonly [string, number])[],
  value: unknown,
  retired: unknown,
): void {
  const ledger = record(value);
  const retiredValues = list(retired).map((entry) => uint(entry, 0xffff));
  for (const [name, number] of active) {
    if (ledger[name] !== number) throw new Error(`Opcode assignment changed or missing: ${name}`);
  }
  const assignments = Object.values(ledger).map((entry) => uint(entry, 0xffff));
  if (new Set(assignments).size !== assignments.length) throw new Error("Reused ledger assignment");
  for (const [name, number] of Object.entries(ledger)) {
    if (!active.some((entry) => entry[0] === name) && !retiredValues.includes(uint(number)))
      throw new Error(`Removed value must remain retired: ${name}`);
  }
}

function validateDictionaries(tables: WireTables, selected: Record<string, unknown>): void {
  const dictionaries = record(selected.dictionaryMembers);
  for (const [name, layout] of Object.entries(tables.structs)) {
    const members = record(dictionaries[name]);
    if (Object.keys(members).length !== layout.fields.length)
      throw new Error(`Incomplete dictionary ${name}`);
    for (const member of layout.fields) validateDictionaryMember(members, member);
  }
  const routes = record(selected.events);
  const omit = record(selected.omit);
  for (const [name, members] of Object.entries(omit))
    validateOmissions(name, members, routes, tables);
}

function validateDictionaryMember(members: Record<string, unknown>, field: Field): void {
  const target = members[field.name];
  if (target !== null && typeof target !== "string")
    throw new Error(`Missing dictionary member ${field.name}`);
}

function validateOmissions(
  name: string,
  members: unknown,
  routes: Record<string, unknown>,
  tables: WireTables,
): void {
  for (const member of list(members).map(text)) {
    if (!tables.completions.some((entry) => entry.name === routes[`${name}.${member}`]))
      throw new Error("Omitted callback needs an event route");
  }
}

function browserMap(
  value: unknown,
  enums: Record<string, number>,
): Record<string, string | number | null> {
  const map = record(value);
  for (const [name, entry] of Object.entries(map)) {
    if (
      !(name in enums) ||
      !(entry === null || typeof entry === "string" || typeof entry === "number")
    )
      throw new Error("Invalid enum lowering");
  }
  if (Object.keys(map).length !== Object.keys(enums).length)
    throw new Error("Incomplete enum lowering");
  return map as Record<string, string | number | null>;
}

function macro(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
}

function fixedSize(type: string): number | null {
  if (type === "uint16") return 2;
  if (
    type.startsWith("object.") ||
    type.startsWith("bitflag.") ||
    ["handle", "token", "uint64", "usize", "float64", "float64_supertype"].includes(type)
  )
    return 8;
  if (
    type.startsWith("enum.") ||
    ["uint32", "int32", "bool", "float32", "nullable_float32"].includes(type)
  )
    return 4;
  return null;
}

function cFields(name: string, members: readonly Field[], start = 0): string[] {
  let offset: number | null = start;
  const lines = [
    `/* ${name}: wire order; *_OFFSET is present only before variable-length data. */`,
  ];
  for (const [index, member] of members.entries()) {
    const prefix = `WAFFLE_GPU_${macro(name)}_${macro(member.name)}`;
    const size = fixedSize(member.type);
    const align =
      size === 2
        ? 2
        : size === 8 && !member.type.startsWith("object.") && member.type !== "handle"
          ? 8
          : 4;
    if (offset !== null) offset = Math.ceil(offset / align) * align;
    lines.push(
      `#define ${prefix}_INDEX ${index}u /* ${member.type}${member.optional ? "; optional" : ""} */`,
    );
    if (offset !== null) lines.push(`#define ${prefix}_OFFSET ${offset}u`);
    offset = offset !== null && size !== null ? offset + size : null;
  }
  return lines;
}

function cHeader(
  tables: WireTables,
  hashes: Record<string, string>,
  objectKinds: Record<string, unknown>,
  payload: Record<string, unknown>,
): string {
  const constants = tables.calls
    .map((entry) => `#define WAFFLE_GPU_OP_${macro(entry.name)} ${entry.opcode}u`)
    .concat(
      tables.records.map((entry) => `#define WAFFLE_GPU_OP_${macro(entry.name)} ${entry.opcode}u`),
      tables.completions.map(
        (entry) => `#define WAFFLE_GPU_REPLY_${macro(entry.name)} ${entry.kind}u`,
      ),
    );
  const arena = Object.entries(payload).map(
    ([name, value]) => `#define WAFFLE_GPU_PAYLOAD_${macro(name)} ${uint(value)}u`,
  );
  const objects = Object.entries(objectKinds).map(
    ([name, number]) => `#define WAFFLE_GPU_OBJECT_${macro(name)} ${uint(number)}u`,
  );
  const values = Object.entries(tables.enums).flatMap(([name, entries]) =>
    Object.entries(entries).map(
      ([entry, number]) => `#define WAFFLE_GPU_${macro(name)}_${macro(entry)} UINT64_C(${number})`,
    ),
  );
  const layouts = tables.calls
    .flatMap((call) =>
      [
        `/* C return: ${call.cReturn}; receiver: ${call.receiver}, ${call.context}; callback future stays guest-local. */`,
      ].concat(cFields(call.name, call.fields, 8)),
    )
    .concat(
      Object.entries(tables.structs).flatMap(([name, value]) => cFields(name, value.fields)),
      tables.completions.flatMap((entry) => cFields(`reply_${entry.name}`, entry.fields, 16)),
      tables.records.flatMap((entry) => cFields(entry.name, entry.fields, 8)),
    );
  return `/* Generated by tooling/gpu-stream.ts. Do not edit.\n * YAML: BSD-3-Clause, webgpu-native/webgpu-headers a1dc77409bb2b8bd80540cbf4b8db219e123e909.\n * Wire layouts, not C ABI struct layouts. Include alongside <webgpu/webgpu.h>.\n * Input digest: ${sha256(JSON.stringify(hashes))}\n */\n#ifndef WAFFLE_GPU_STREAM_H\n#define WAFFLE_GPU_STREAM_H\n#include <stddef.h>\n#include <stdint.h>\n#include <string.h>\n#define WAFFLE_GPU_ROOT_ID 1u\n#define WAFFLE_GPU_ROOT_GENERATION 1u\n#define WAFFLE_GPU_SURFACE_SOURCE_WAFFLE 4096u\n#define WAFFLE_GPU_COMMAND_HEADER_SIZE 8u\n#define WAFFLE_GPU_COMPLETION_HEADER_SIZE 16u\n#define WAFFLE_GPU_TOKEN_SIZE 8u\n${constants.concat(objects, arena).join("\n")}\n${values.join("\n")}\n${layouts.join("\n")}\n${cWriter}\n#endif\n`;
}

const cWriter = `/* Cursors avoid native padding, alignment and endianness assumptions. */
typedef struct WaffleGpuWriter { uint8_t *data; size_t capacity, offset; int error; } WaffleGpuWriter;
static inline void waffle_gpu_u8(WaffleGpuWriter *w, uint8_t v) {
    if (w->error || w->offset >= w->capacity) { w->error = 1; return; }
    w->data[w->offset++] = v;
}
static inline void waffle_gpu_align(WaffleGpuWriter *w, size_t alignment) {
    while (!w->error && w->offset % alignment) waffle_gpu_u8(w, 0);
}
static inline void waffle_gpu_u32(WaffleGpuWriter *w, uint32_t v) {
    waffle_gpu_align(w, 4);
    for (unsigned i = 0; i < 4; ++i) waffle_gpu_u8(w, (uint8_t)(v >> (8 * i)));
}
static inline void waffle_gpu_u16(WaffleGpuWriter *w, uint16_t v) {
    waffle_gpu_align(w, 2);
    for (unsigned i = 0; i < 2; ++i) waffle_gpu_u8(w, (uint8_t)(v >> (8 * i)));
}
static inline void waffle_gpu_u64(WaffleGpuWriter *w, uint64_t v) {
    waffle_gpu_align(w, 8);
    for (unsigned i = 0; i < 8; ++i) waffle_gpu_u8(w, (uint8_t)(v >> (8 * i)));
}
#define WAFFLE_GPU_WHOLE_MAP_SIZE UINT64_MAX
static inline uint64_t waffle_gpu_map_size(size_t size) {
    return size == SIZE_MAX ? WAFFLE_GPU_WHOLE_MAP_SIZE : (uint64_t)size;
}
static inline void waffle_gpu_f64(WaffleGpuWriter *w, double v) {
    uint64_t bits; memcpy(&bits, &v, sizeof(bits)); waffle_gpu_u64(w, bits);
}
static inline void waffle_gpu_f32(WaffleGpuWriter *w, float v) {
    uint32_t bits; memcpy(&bits, &v, sizeof(bits)); waffle_gpu_u32(w, bits);
}
static inline void waffle_gpu_handle(WaffleGpuWriter *w, uint32_t id, uint32_t generation) {
    waffle_gpu_u32(w, id); waffle_gpu_u32(w, generation);
}
static inline void waffle_gpu_token(WaffleGpuWriter *w, uint32_t token) {
    waffle_gpu_u32(w, token); waffle_gpu_u32(w, 0);
}
static inline void waffle_gpu_string(WaffleGpuWriter *w, const char *bytes, uint32_t length) {
    waffle_gpu_u32(w, bytes ? length : UINT32_MAX);
    if (!bytes) return;
    for (uint32_t i = 0; !w->error && i < length; ++i) waffle_gpu_u8(w, (uint8_t)bytes[i]);
    waffle_gpu_align(w, 4);
}
static inline size_t waffle_gpu_begin(WaffleGpuWriter *w, uint16_t opcode) {
    waffle_gpu_align(w, 8);
    size_t start = w->offset;
    waffle_gpu_u32(w, opcode); waffle_gpu_u32(w, 0); return start;
}
static inline void waffle_gpu_end(WaffleGpuWriter *w, size_t start) {
    waffle_gpu_align(w, 8);
    if (w->error || start > w->offset || w->offset - start > UINT32_MAX || w->offset - start < 8) { w->error = 1; return; }
    uint32_t length = (uint32_t)(w->offset - start);
    for (unsigned i = 0; i < 4; ++i) w->data[start + 4 + i] = (uint8_t)(length >> (8 * i));
}`;

function sharedFieldSource(tables: WireTables): Map<string, string> {
  const counts = new Map<string, number>();
  const layouts = tables.calls
    .map((call) => call.fields)
    .concat(
      Object.values(tables.structs).map((entry) => entry.fields),
      tables.completions.map((entry) => entry.fields),
      tables.records.map((entry) => entry.fields),
    );
  for (const members of layouts) {
    if (members.length < 2) continue;
    const key = JSON.stringify(members);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const shared = new Map<string, string>();
  for (const [key, count] of counts) {
    if (count > 1) shared.set(key, `gpuFields${shared.size}`);
  }
  return shared;
}

function tableSource(tables: WireTables): string {
  const shared = sharedFieldSource(tables);
  const declarations = Array.from(
    shared,
    ([value, name]) => `const ${name}: Field[] = ${value};`,
  ).join("\n");
  const browserEnums = Object.entries(tables.browserEnums)
    .map(([name, entries]) => {
      const native = JSON.stringify(entries) === JSON.stringify(tables.enums[name]);
      return `${JSON.stringify(name)}: ${native ? `gpuEnums[${JSON.stringify(name)}]` : JSON.stringify(entries)}`;
    })
    .join(",\n");
  const body = JSON.stringify(
    { ...tables, enums: {}, browserEnums: {} },
    (key, value: unknown) => {
      if (key !== "fields") return value;
      return shared.get(JSON.stringify(value)) ?? value;
    },
    2,
  )
    .replace(/"(gpuFields[0-9]+)"/g, "$1")
    .replace('"enums": {}', '"enums": gpuEnums')
    .replace('"browserEnums": {}', `"browserEnums": {${browserEnums}}`);
  return `const gpuEnums = ${JSON.stringify(tables.enums, null, 2)};\n${declarations}\nexport const gpuStream = ${body} satisfies WireTables;`;
}

/** @public Tool entry used by quality and focused tests, never imported by runtime entries. */
export async function generate(root = packageRoot, check = false): Promise<void> {
  const yamlBytes = await Bun.file(resolve(root, schemaPath)).bytes();
  const license = await Bun.file(resolve(root, licensePath)).bytes();
  if (
    sha256(yamlBytes) !== selection.upstream.sha256 ||
    sha256(license) !== selection.upstream.licenseSha256 ||
    sha256(await Bun.file(resolve(root, "browser/gpu/upstream/webgpu.h")).bytes()) !==
      selection.upstream.headerSha256
  )
    throw new Error("Pinned upstream schema/license hash mismatch");
  const input: unknown = await Bun.file(resolve(root, "browser/gpu/stream.json")).json();
  if (JSON.stringify(record(input).upstream) !== JSON.stringify(selection.upstream))
    throw new Error("Changed upstream pin");
  const tables = compileSchema(Bun.YAML.parse(new TextDecoder().decode(yamlBytes)), input);
  const hashes = Object.fromEntries(
    await Promise.all(
      fixedInputs.map(async (path) => [path, sha256(await Bun.file(resolve(root, path)).bytes())]),
    ),
  );
  const raw = `// Generated by tooling/gpu-stream.ts. Do not edit.\n// YAML and numeric enums: BSD-3-Clause; see ../upstream/LICENSE.\nimport type { Field, WireTables } from "../../../tooling/gpu-stream-model.ts";\n${tableSource(tables)}\nexport const gpuStreamSources = ${JSON.stringify(hashes, null, 2)};\nexport const gpuDescriptorAdapters = ${JSON.stringify(record(input).descriptors, null, 2)};\nexport const gpuEventRoutes = ${JSON.stringify(record(input).events, null, 2)};\nexport const gpuSentinels = ${JSON.stringify(record(input).sentinels, null, 2)};\nexport const gpuDictionaryMembers = ${JSON.stringify(record(input).dictionaryMembers, null, 2)};\nexport const gpuDictionaryRules = ${JSON.stringify(record(input).dictionaryRules, null, 2)};\nexport const gpuObjectKinds = ${JSON.stringify(record(input).objectKinds, null, 2)};\nexport const gpuCOutputs = ${JSON.stringify(record(input).cOutput, null, 2)};\nexport const gpuPayloadLayout = ${JSON.stringify(record(input).payloadArena, null, 2)};\nexport const gpuWholeMapSize = 0xffffffffffffffffn;\n`;
  const formatter = Bun.spawn(
    [
      "bun",
      "x",
      "--no-install",
      "oxfmt",
      "--stdin-filepath",
      resolve(packageRoot, outputs[0] ?? "tables.ts"),
    ],
    { cwd: packageRoot, stdin: new Blob([raw]), stdout: "pipe", stderr: "pipe" },
  );
  const formatted = await new Response(formatter.stdout).text();
  if ((await formatter.exited) !== 0) throw new Error(await new Response(formatter.stderr).text());
  const content = [
    formatted,
    cHeader(tables, hashes, record(record(input).objectKinds), record(record(input).payloadArena)),
  ];
  for (const [index, path] of outputs.entries()) {
    const expected = content[index];
    if (expected === undefined) throw new Error("Missing generated output");
    if (!check) {
      await Bun.write(resolve(root, path), expected);
      continue;
    }
    if (
      !(await Bun.file(resolve(root, path)).exists()) ||
      (await Bun.file(resolve(root, path)).text()) !== expected
    )
      throw new Error(`Stale GPU output: ${path}`);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) throw new Error("Usage: gpu-stream.ts [--check]");
  await generate(packageRoot, args.includes("--check"));
}
