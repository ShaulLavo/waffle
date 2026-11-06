import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import coverage from "../browser/gpu/method-coverage.json";
import selection from "../browser/gpu/stream.json";
import { checkCoverage, coverageReport, validateCoverage } from "../tooling/gpu-coverage.ts";
import { list, record } from "../tooling/gpu-stream-model.ts";

const yaml: unknown = Bun.YAML.parse(
  readFileSync(new URL("../browser/gpu/upstream/webgpu.yml", import.meta.url), "utf8"),
);

function changedEntry(name: string, changes: Record<string, unknown>) {
  return {
    ...coverage,
    methods: coverage.methods.map((entry) =>
      entry.name === name ? { ...entry, ...changes } : entry,
    ),
  };
}

function changedYamlMethods(change: (methods: unknown[]) => unknown[]): unknown {
  const source = record(yaml);
  const objects = list(source.objects).map((value) => {
    const object = record(value);
    return object.name === "buffer" ? { ...object, methods: change(list(object.methods)) } : object;
  });
  return { ...source, objects };
}

const selectedName = "instance.request_adapter";
const deferredName = "buffer.destroy";

test("actual pinned method classification validates in normal test discovery", async () => {
  const entries = await checkCoverage();
  expect(entries).toHaveLength(150);
  expect(entries.filter((entry) => entry.category === "selected")).toHaveLength(
    selection.calls.length,
  );
  expect(entries.filter((entry) => entry.name.startsWith("function."))).toHaveLength(4);
});

test("a missing classification fails instead of acquiring a default category", () => {
  const missing = {
    ...coverage,
    methods: coverage.methods.filter((entry) => entry.name !== deferredName),
  };
  expect(() => validateCoverage(yaml, missing, selection)).toThrow(
    `Unclassified YAML declaration: ${deferredName}`,
  );
});

test("new upstream methods must be explicitly classified", () => {
  const added = changedYamlMethods((methods) => methods.concat([{ name: "unknown_new_method" }]));
  expect(() => validateCoverage(added, coverage, selection)).toThrow(
    "Unclassified YAML declaration: buffer.unknown_new_method",
  );
});

test("removed upstream methods leave a failing stale entry", () => {
  const removed = changedYamlMethods((methods) =>
    methods.filter((method) => record(method).name !== "destroy"),
  );
  expect(() => validateCoverage(removed, coverage, selection)).toThrow(
    `Stale coverage entry: ${deferredName}`,
  );
});

test("duplicate classification and duplicate YAML declarations fail", () => {
  const duplicate = { ...coverage, methods: coverage.methods.concat([coverage.methods[0]!]) };
  expect(() => validateCoverage(yaml, duplicate, selection)).toThrow("Duplicate coverage entry");
  const duplicateYaml = changedYamlMethods((methods) => methods.concat([{ name: "destroy" }]));
  expect(() => validateCoverage(duplicateYaml, coverage, selection)).toThrow(
    "Duplicate YAML declaration",
  );
});

test("renamed and invented classification entries fail", () => {
  const stale = changedEntry(deferredName, { name: "buffer.no_such_method" });
  expect(() => validateCoverage(yaml, stale, selection)).toThrow(
    "Stale coverage entry: buffer.no_such_method",
  );
});

test("invalid categories never silently defer", () => {
  for (const category of ["unknown", "implemented", "default", null, ""])
    expect(() =>
      validateCoverage(yaml, changedEntry(deferredName, { category }), selection),
    ).toThrow("Invalid coverage category");
});

test("selected calls cannot hide under deferred or C-only categories", () => {
  for (const category of ["deferred", "c-only-adaptation", "unsupported"])
    expect(() =>
      validateCoverage(yaml, changedEntry(selectedName, { category, slice: "G1" }), selection),
    ).toThrow("Selected stream call classified as");
});

test("selection requires a real stream call, not a claimed implementation", () => {
  const invented = changedEntry(deferredName, { category: "selected", call: selection.calls[0] });
  expect(() => validateCoverage(yaml, invented, selection)).toThrow(
    `Classified selected call absent from stream: ${deferredName}`,
  );
  const removedCall = selection.calls.find((call) => call.name === "surface.unconfigure");
  if (!removedCall) throw new Error("Selected call missing");
  const removed = {
    ...selection,
    calls: selection.calls.filter((call) => call.name !== removedCall.name),
    retiredOpcodes: [removedCall.opcode],
  };
  expect(() => validateCoverage(yaml, coverage, removed)).toThrow(
    "Classified selected call absent from stream",
  );
});

test("opcode, recording context and named lowering must agree exactly", () => {
  const actual = coverage.methods.find((entry) => entry.name === selectedName);
  if (!actual || !("call" in actual)) throw new Error("Selected coverage fixture missing");
  const call = actual.call;
  for (const changes of [
    { opcode: 99 },
    { context: "pass" },
    { lowering: { kind: "method", member: "wrongMethod" } },
  ])
    expect(() =>
      validateCoverage(
        yaml,
        changedEntry(selectedName, { call: { ...call, ...changes } }),
        selection,
      ),
    ).toThrow("Selected call/lowering metadata mismatch");
});

test("missing concrete reasons and approved slices fail", () => {
  for (const reason of ["", "   ", null, "TODO"])
    expect(() =>
      validateCoverage(yaml, changedEntry(deferredName, { reason }), selection),
    ).toThrow();
  for (const slice of [undefined, null, "", "later", "G9"])
    expect(() => validateCoverage(yaml, changedEntry(deferredName, { slice }), selection)).toThrow(
      "approved slice",
    );
  expect(() =>
    validateCoverage(
      yaml,
      changedEntry("buffer.get_mapped_range", { slice: undefined }),
      selection,
    ),
  ).toThrow("approved slice");
});

test("unsupported calls need a documented boundary and reason", () => {
  const missing = changedEntry("external_texture.set_label", { boundary: undefined });
  expect(() => validateCoverage(yaml, missing, selection)).toThrow(
    "documented browser/guest boundary",
  );
  expect(() =>
    validateCoverage(yaml, changedEntry("external_texture.set_label", { reason: "" }), selection),
  ).toThrow();
});

test("global C functions also fail closed on upstream additions", () => {
  const source = record(yaml);
  const added = {
    ...source,
    functions: list(source.functions).concat([{ name: "unknown_global_function" }]),
  };
  expect(() => validateCoverage(added, coverage, selection)).toThrow(
    "Unclassified YAML declaration: function.unknown_global_function",
  );
});

test("coverage cannot silently switch upstream pins", () => {
  const changed = { ...coverage, upstream: { ...coverage.upstream, revision: "different" } };
  expect(() => validateCoverage(yaml, changed, selection)).toThrow("upstream pin mismatch");
});

test("the rerunnable report uses classifications and leaves the full G1 gate open", async () => {
  const entries = await checkCoverage();
  const report = coverageReport(entries);
  expect(report).toContain("146 YAML object methods and 4 global functions");
  expect(report).toContain(`selected: ${selection.calls.length}`);
  expect(report).toContain("render_pass_encoder.execute_bundles");
  expect(report).toContain("render_bundle_encoder.finish");
  expect(report).toContain("query_set.destroy");
  expect(report).toContain("real textured depth-tested scene");
  expect(report).toContain("large-blob fairness");
  expect(report).toContain("C-only adaptations remain planned");
  expect(
    coverageReport(entries.filter((entry) => entry.name !== "queue.write_texture")),
  ).not.toContain("queue.write_texture");
});

test("stream lowering changes require an explicit classification update", () => {
  const stream = {
    ...selection,
    calls: selection.calls.map((call) =>
      call.name === selectedName
        ? { ...call, lowering: { kind: "method", member: "inventedRequestAdapter" } }
        : call,
    ),
  };
  expect(() => validateCoverage(yaml, coverage, stream)).toThrow(
    "Selected call/lowering metadata mismatch",
  );
});

test("unknown groups and malformed classification schemas fail", () => {
  expect(() =>
    validateCoverage(yaml, changedEntry(deferredName, { group: "everything-else" }), selection),
  ).toThrow("Invalid coverage group");
  expect(() => validateCoverage(yaml, { ...coverage, schemaVersion: 2 }, selection)).toThrow(
    "Invalid coverage schema version",
  );
  expect(() => validateCoverage(yaml, { ...coverage, methods: null }, selection)).toThrow(
    "Expected array",
  );
});

test("supported G1 and G2 declarations cannot borrow an unrelated unsupported boundary", () => {
  for (const name of ["queue.write_buffer", "buffer.map_async"]) {
    for (const boundary of ["no-external-textures", "no-native-api"]) {
      const changed = changedEntry(name, { category: "unsupported", boundary });
      expect(() => validateCoverage(yaml, changed, selection)).toThrow();
    }
  }
});

test("the two documented exclusions cannot exchange their boundaries", () => {
  for (const { name, boundary } of [
    { name: "external_texture.set_label", boundary: "no-native-api" },
    { name: "command_encoder.write_timestamp", boundary: "no-external-textures" },
  ]) {
    expect(() => validateCoverage(yaml, changedEntry(name, { boundary }), selection)).toThrow(
      "boundary does not apply",
    );
  }
});

test("long padded placeholders are not concrete per-method reasons", () => {
  for (const reason of [
    "  TODO: classify this method later, after implementing the protocol.",
    "\tTBD: determine which supported operation this method represents.",
    "  later this method will have a concrete slice and classification.",
  ]) {
    expect(() => validateCoverage(yaml, changedEntry(deferredName, { reason }), selection)).toThrow(
      "concrete reason",
    );
  }
});
