import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { gpuStream } from "../browser/gpu/generated/tables.ts";
import selection from "../browser/gpu/stream.json" with { type: "json" };
import { compileSchema, sha256 } from "./gpu-stream.ts";
import { list, record, text, uint, type CallLayout } from "./gpu-stream-model.ts";

type Slice = "G1" | "G2";
type Entry = { name: string; group: string; reason: string } & (
  | { category: "selected"; call: Pick<CallLayout, "opcode" | "context" | "lowering"> }
  | { category: "deferred" | "c-only-adaptation"; slice: Slice }
  | { category: "unsupported"; boundary: "no-external-textures" | "no-native-api" }
);

const root = resolve(import.meta.dir, "..");
const groups = [
  "creation",
  "queue",
  "encoder",
  "compute-pass",
  "render-pass",
  "bundle",
  "query",
  "mapping",
  "async",
  "metadata",
  "labels",
  "surface",
  "instance",
];

function nonempty(value: unknown, label: string): string {
  const result = text(value);
  if (!result.trim()) throw new Error(`Missing ${label}`);
  return result;
}

function slice(value: unknown): Slice {
  if (value !== "G1" && value !== "G2") throw new Error("Missing or invalid approved slice");
  return value;
}

function declarations(value: unknown, prefix: string): string[] {
  return list(value).map((item) => `${prefix}.${nonempty(record(item).name, "YAML name")}`);
}

function inventory(yaml: unknown): string[] {
  const source = record(yaml);
  const methods = list(source.objects).flatMap((item) => {
    const object = record(item);
    return declarations(object.methods ?? [], nonempty(object.name, "YAML object"));
  });
  return methods.concat(declarations(source.functions, "function"));
}

function uniqueNames(names: readonly string[], label: string): Set<string> {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new Error(`Duplicate ${label}: ${name}`);
    seen.add(name);
  }
  return seen;
}

function parseEntry(value: unknown, calls: ReadonlyMap<string, CallLayout>): Entry {
  const input = record(value);
  const name = nonempty(input.name, "method name");
  const group = nonempty(input.group, `group for ${name}`);
  const reason = nonempty(input.reason, `concrete reason for ${name}`);
  if (reason.trim().length < 24 || /^(todo|tbd|later)\b/i.test(reason))
    throw new Error(`Missing concrete reason for ${name}`);
  if (!groups.includes(group)) throw new Error(`Invalid coverage group for ${name}`);
  const base = { name, group, reason };
  if (input.category === "selected") return selectedEntry(input, base, calls);
  if (calls.has(name))
    throw new Error(`Selected stream call classified as ${String(input.category)}: ${name}`);
  if (input.category === "deferred" || input.category === "c-only-adaptation")
    return { ...base, category: input.category, slice: slice(input.slice) };
  if (input.category !== "unsupported") throw new Error(`Invalid coverage category for ${name}`);
  if (input.boundary !== "no-external-textures" && input.boundary !== "no-native-api")
    throw new Error(`Missing documented browser/guest boundary for ${name}`);
  return { ...base, category: input.category, boundary: input.boundary };
}

function selectedEntry(
  input: Record<string, unknown>,
  base: Pick<Entry, "name" | "group" | "reason">,
  calls: ReadonlyMap<string, CallLayout>,
): Entry {
  const actual = calls.get(base.name);
  if (!actual) throw new Error(`Classified selected call absent from stream: ${base.name}`);
  const expected = { opcode: actual.opcode, context: actual.context, lowering: actual.lowering };
  if (!isDeepStrictEqual(input.call, expected))
    throw new Error(`Selected call/lowering metadata mismatch: ${base.name}`);
  return { ...base, category: "selected", call: expected };
}

/** Pure boundary validator; every declaration needs its own entry, never a default category. */
export function validateCoverage(yaml: unknown, coverage: unknown, stream: unknown): Entry[] {
  const source = record(coverage);
  if (uint(source.schemaVersion) !== 1) throw new Error("Invalid coverage schema version");
  if (!isDeepStrictEqual(source.upstream, record(stream).upstream))
    throw new Error("Coverage upstream pin mismatch");
  const actual = uniqueNames(inventory(yaml), "YAML declaration");
  const compiled = compileSchema(yaml, stream);
  const calls = new Map(compiled.calls.map((call) => [call.name, call]));
  const entries = list(source.methods).map((entry) => parseEntry(entry, calls));
  const classified = uniqueNames(
    entries.map((entry) => entry.name),
    "coverage entry",
  );
  for (const name of classified)
    if (!actual.has(name)) throw new Error(`Stale coverage entry: ${name}`);
  for (const name of actual)
    if (!classified.has(name)) throw new Error(`Unclassified YAML declaration: ${name}`);
  return entries;
}

/** Reads and verifies the real pins and generated selection without changing any output. */
export async function checkCoverage(): Promise<Entry[]> {
  const yaml = await Bun.file(resolve(root, "browser/gpu/upstream/webgpu.yml")).bytes();
  if (sha256(yaml) !== selection.upstream.sha256) throw new Error("Pinned YAML hash mismatch");
  const input: unknown = await Bun.file(resolve(root, "browser/gpu/method-coverage.json")).json();
  const parsed: unknown = Bun.YAML.parse(new TextDecoder().decode(yaml));
  if (!isDeepStrictEqual(compileSchema(parsed, selection), gpuStream))
    throw new Error("Generated selected stream differs from pinned source/lowering metadata");
  return validateCoverage(parsed, input, selection);
}

/** Counts come only from validated entries. C adaptations are planned, not implemented clients. */
export function coverageReport(entries: readonly Entry[]): string {
  const categories = ["selected", "deferred", "c-only-adaptation", "unsupported"];
  const lines = [
    "# GPU method coverage",
    "",
    `${entries.filter((entry) => !entry.name.startsWith("function.")).length} YAML object methods and ${entries.filter((entry) => entry.name.startsWith("function.")).length} global functions classified.`,
    "Selected means the existing stream and lowering only, not full G1 conformance.",
    "C-only adaptations remain planned guest-client work; this gate implements none of them.",
    "",
  ];
  for (const category of categories)
    lines.push(`${category}: ${entries.filter((entry) => entry.category === category).length}`);
  for (const milestone of ["G1", "G2"]) {
    const pending = entries.filter((entry) => "slice" in entry && entry.slice === milestone);
    lines.push("", `## ${milestone} open: ${pending.length} declarations`);
    for (const group of groups) appendGroup(lines, group, pending);
  }
  lines.push("", "## Outside the browser/guest boundary");
  for (const entry of entries) {
    if (entry.category === "unsupported") lines.push(`- ${entry.name}: ${entry.reason}`);
  }
  lines.push(
    "",
    "G1 remains open: complete creation, queue uploads, encoders, passes, bundles and queries;",
    "the real textured depth-tested scene; large-blob fairness and multi-connection frame gates.",
    "G0.3 desktop and physical-iPhone qualification remain separate and open.",
  );
  return lines.join("\n") + "\n";
}

function appendGroup(lines: string[], group: string, entries: readonly Entry[]): void {
  const members = entries.filter((entry) => entry.group === group);
  if (members.length)
    lines.push(`- ${group} (${members.length}): ${members.map((entry) => entry.name).join(", ")}`);
}

if (import.meta.main) {
  if (process.argv.length !== 2) throw new Error("Usage: bun tooling/gpu-coverage.ts");
  process.stdout.write(coverageReport(await checkCoverage()));
}
