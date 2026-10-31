import { expect, test } from "bun:test";
import {
  planSelectedArchive,
  type ImportInputError,
  type ImportLimitAdmission,
  type ImportLimits,
} from "../fs/workspace-import-admission.js";

type Expected =
  | { readonly kind: "admitted"; readonly defaults?: boolean }
  | {
      readonly kind: "refused";
      readonly field: ImportInputError["field"];
      readonly rule: ImportInputError["rule"];
    };
interface AdmissionCase {
  readonly name: string;
  readonly input: unknown;
  readonly expected: Expected;
}

const cases: readonly AdmissionCase[] = [
  { name: "defaults", input: { archiveBytes: 1 }, expected: { kind: "admitted", defaults: true } },
  {
    name: "wire ceiling equality",
    input: { archiveBytes: 8_388_608 },
    expected: { kind: "admitted" },
  },
  {
    name: "wire ceiling one over",
    input: { archiveBytes: 8_388_609 },
    expected: { kind: "refused", field: "archiveBytes", rule: "range" },
  },
  {
    name: "empty selected file",
    input: { archiveBytes: 0 },
    expected: { kind: "refused", field: "archiveBytes", rule: "range" },
  },
  {
    name: "negative selected length",
    input: { archiveBytes: -1 },
    expected: { kind: "refused", field: "archiveBytes", rule: "range" },
  },
  {
    name: "fractional selected length",
    input: { archiveBytes: 1.5 },
    expected: { kind: "refused", field: "archiveBytes", rule: "integer" },
  },
  {
    name: "unsafe selected length",
    input: { archiveBytes: Number.MAX_SAFE_INTEGER + 1 },
    expected: { kind: "refused", field: "archiveBytes", rule: "integer" },
  },
  {
    name: "nonnumeric length",
    input: { archiveBytes: "1" },
    expected: { kind: "refused", field: "archiveBytes", rule: "integer" },
  },
  {
    name: "null input",
    input: null,
    expected: { kind: "refused", field: "input", rule: "shape" },
  },
  {
    name: "array input",
    input: [],
    expected: { kind: "refused", field: "input", rule: "shape" },
  },
  {
    name: "extra input key",
    input: { archiveBytes: 1, name: "example" },
    expected: { kind: "refused", field: "input", rule: "shape" },
  },
  {
    name: "missing length",
    input: {},
    expected: { kind: "refused", field: "archiveBytes", rule: "integer" },
  },
  {
    name: "null limits",
    input: { archiveBytes: 1, limits: null },
    expected: { kind: "refused", field: "limits", rule: "shape" },
  },
  {
    name: "extra limit key",
    input: { archiveBytes: 1, limits: { other: 1 } },
    expected: { kind: "refused", field: "limits", rule: "shape" },
  },
  {
    name: "lower wire equality",
    input: { archiveBytes: 4096, limits: { maxArchiveBytes: 4096 } },
    expected: { kind: "admitted" },
  },
  {
    name: "lower wire one over",
    input: { archiveBytes: 4097, limits: { maxArchiveBytes: 4096 } },
    expected: { kind: "refused", field: "archiveBytes", rule: "range" },
  },
  {
    name: "wire override too high",
    input: { archiveBytes: 1, limits: { maxArchiveBytes: 8_388_609 } },
    expected: { kind: "refused", field: "maxArchiveBytes", rule: "range" },
  },
  {
    name: "entry minimum",
    input: { archiveBytes: 1, limits: { maxEntries: 0 } },
    expected: { kind: "refused", field: "maxEntries", rule: "range" },
  },
  {
    name: "directory-only profile",
    input: {
      archiveBytes: 100,
      limits: { maxEntries: 1, maxFiles: 0, maxFileBytes: 0, maxTotalBytes: 0 },
    },
    expected: { kind: "admitted" },
  },
  {
    name: "file count versus root entry",
    input: { archiveBytes: 1, limits: { maxEntries: 128 } },
    expected: { kind: "refused", field: "maxFiles", rule: "relation" },
  },
  {
    name: "file count matching remaining entries",
    input: { archiveBytes: 1, limits: { maxEntries: 129 } },
    expected: { kind: "admitted" },
  },
  {
    name: "file size versus total",
    input: { archiveBytes: 1, limits: { maxTotalBytes: 0 } },
    expected: { kind: "refused", field: "maxFileBytes", rule: "relation" },
  },
  {
    name: "metadata minimum",
    input: { archiveBytes: 1, limits: { maxMetadataBytes: 1 } },
    expected: { kind: "admitted" },
  },
  {
    name: "metadata above ceiling",
    input: { archiveBytes: 1, limits: { maxMetadataBytes: 262_145 } },
    expected: { kind: "refused", field: "maxMetadataBytes", rule: "range" },
  },
  {
    name: "field precedence before relation",
    input: { archiveBytes: 8_388_609, limits: { maxFiles: 129 } },
    expected: { kind: "refused", field: "maxFiles", rule: "range" },
  },
  {
    name: "undefined option means omitted",
    input: { archiveBytes: 1, limits: { maxEntries: undefined } },
    expected: { kind: "admitted" },
  },
  {
    name: "NaN selected length",
    input: { archiveBytes: Number.NaN },
    expected: { kind: "refused", field: "archiveBytes", rule: "integer" },
  },
  {
    name: "infinite selected length",
    input: { archiveBytes: Number.POSITIVE_INFINITY },
    expected: { kind: "refused", field: "archiveBytes", rule: "integer" },
  },
];

function refusalResult(
  field: ImportInputError["field"],
  rule: ImportInputError["rule"],
): ImportLimitAdmission {
  return { kind: "refused", refusal: { kind: "input", field, rule } };
}

test.each(cases)("$name", ({ input, expected }) => {
  const result = planSelectedArchive(input);
  if (expected.kind === "admitted") {
    expect(result.kind).toBe("admitted");
    if (result.kind !== "admitted") return;
    if (expected.defaults) {
      expect(result.plan.limits).toEqual({
        maxArchiveBytes: 8_388_608,
        maxEntries: 256,
        maxFiles: 128,
        maxFileBytes: 4_194_304,
        maxTotalBytes: 4_194_304,
        maxMetadataBytes: 262_144,
      });
    }
    return;
  }
  expect(result).toEqual(refusalResult(expected.field, expected.rule));
});

test("admitted plans freeze copied limits and ignore input mutation", () => {
  const input = {
    archiveBytes: 4096,
    limits: {
      maxArchiveBytes: 4096,
      maxEntries: 129,
      maxFiles: 2,
      maxFileBytes: 10,
      maxTotalBytes: 20,
      maxMetadataBytes: 1024,
    },
  };
  const result = planSelectedArchive(input);
  expect(result.kind).toBe("admitted");
  if (result.kind !== "admitted") return;

  input.archiveBytes = 1;
  input.limits.maxArchiveBytes = 1;
  input.limits.maxEntries = 1;
  input.limits.maxFiles = 0;
  input.limits.maxFileBytes = 0;
  input.limits.maxTotalBytes = 0;
  input.limits.maxMetadataBytes = 1;
  expect(result.plan.archiveBytes).toBe(4096);
  expect(result.plan.limits).toEqual({
    maxArchiveBytes: 4096,
    maxEntries: 129,
    maxFiles: 2,
    maxFileBytes: 10,
    maxTotalBytes: 20,
    maxMetadataBytes: 1024,
  });
  expect(Object.isFrozen(result.plan)).toBe(true);
  expect(Object.isFrozen(result.plan.limits)).toBe(true);
});

test("separate calls receive separate frozen plans", () => {
  const first = planSelectedArchive({ archiveBytes: 1 });
  const second = planSelectedArchive({ archiveBytes: 1 });
  expect(first.kind).toBe("admitted");
  expect(second.kind).toBe("admitted");
  if (first.kind !== "admitted" || second.kind !== "admitted") return;
  expect(first.plan).not.toBe(second.plan);
  expect(first.plan.limits).not.toBe(second.plan.limits);
  expect(Object.isFrozen(first.plan)).toBe(true);
  expect(Object.isFrozen(first.plan.limits)).toBe(true);
  expect(Object.isFrozen(second.plan)).toBe(true);
  expect(Object.isFrozen(second.plan.limits)).toBe(true);
});

const minimumLimits: ImportLimits = {
  maxArchiveBytes: 1,
  maxEntries: 1,
  maxFiles: 0,
  maxFileBytes: 0,
  maxTotalBytes: 0,
  maxMetadataBytes: 1,
};
const ceilingLimits: ImportLimits = {
  maxArchiveBytes: 8_388_608,
  maxEntries: 256,
  maxFiles: 128,
  maxFileBytes: 4_194_304,
  maxTotalBytes: 4_194_304,
  maxMetadataBytes: 262_144,
};
const limitFields: readonly (keyof ImportLimits)[] = [
  "maxArchiveBytes",
  "maxEntries",
  "maxFiles",
  "maxFileBytes",
  "maxTotalBytes",
  "maxMetadataBytes",
];

test.each(limitFields)("%s boundary and undefined controls", (field) => {
  const minimum = planSelectedArchive({ archiveBytes: 1, limits: minimumLimits });
  expect(minimum.kind).toBe("admitted");
  if (minimum.kind !== "admitted") return;
  expect(minimum.plan.limits[field]).toBe(minimumLimits[field]);

  const ceiling = planSelectedArchive({
    archiveBytes: 1,
    limits: { [field]: ceilingLimits[field] },
  });
  expect(ceiling.kind).toBe("admitted");
  if (ceiling.kind !== "admitted") return;
  expect(ceiling.plan.limits[field]).toBe(ceilingLimits[field]);

  expect(
    planSelectedArchive({ archiveBytes: 1, limits: { [field]: minimumLimits[field] - 1 } }),
  ).toEqual(refusalResult(field, "range"));
  expect(
    planSelectedArchive({ archiveBytes: 1, limits: { [field]: ceilingLimits[field] + 1 } }),
  ).toEqual(refusalResult(field, "range"));
  const omitted = planSelectedArchive({ archiveBytes: 1, limits: { [field]: undefined } });
  expect(omitted.kind).toBe("admitted");
  if (omitted.kind !== "admitted") return;
  expect(omitted.plan.limits).toEqual(ceilingLimits);
});

const invalidLimitCases = limitFields.flatMap((field) =>
  [
    "1",
    null,
    true,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ].map((value) => ({ field, value })),
);
test.each(invalidLimitCases)("$field rejects non-safe integer $value", ({ field, value }) => {
  expect(planSelectedArchive({ archiveBytes: 1, limits: { [field]: value } })).toEqual(
    refusalResult(field, "integer"),
  );
});

const precedenceCases: readonly AdmissionCase[] = [
  {
    name: "input shape before length",
    input: { archiveBytes: "1", extra: 0 },
    expected: { kind: "refused", field: "input", rule: "shape" },
  },
  {
    name: "length integer before limits shape",
    input: { archiveBytes: "1", limits: null },
    expected: { kind: "refused", field: "archiveBytes", rule: "integer" },
  },
  {
    name: "length positive before limits shape",
    input: { archiveBytes: 0, limits: null },
    expected: { kind: "refused", field: "archiveBytes", rule: "range" },
  },
  {
    name: "limits shape before fields",
    input: { archiveBytes: 1, limits: { other: 0, maxArchiveBytes: "1" } },
    expected: { kind: "refused", field: "limits", rule: "shape" },
  },
  {
    name: "archive cap before entries",
    input: { archiveBytes: 1, limits: { maxArchiveBytes: 0, maxEntries: "1" } },
    expected: { kind: "refused", field: "maxArchiveBytes", rule: "range" },
  },
  {
    name: "entries before files",
    input: { archiveBytes: 1, limits: { maxEntries: 0, maxFiles: "1" } },
    expected: { kind: "refused", field: "maxEntries", rule: "range" },
  },
  {
    name: "files before file bytes",
    input: { archiveBytes: 1, limits: { maxFiles: -1, maxFileBytes: "1" } },
    expected: { kind: "refused", field: "maxFiles", rule: "range" },
  },
  {
    name: "file bytes before total bytes",
    input: { archiveBytes: 1, limits: { maxFileBytes: -1, maxTotalBytes: "1" } },
    expected: { kind: "refused", field: "maxFileBytes", rule: "range" },
  },
  {
    name: "total bytes before metadata",
    input: { archiveBytes: 1, limits: { maxTotalBytes: -1, maxMetadataBytes: "1" } },
    expected: { kind: "refused", field: "maxTotalBytes", rule: "range" },
  },
  {
    name: "metadata before relations",
    input: { archiveBytes: 1, limits: { maxEntries: 1, maxMetadataBytes: 0 } },
    expected: { kind: "refused", field: "maxMetadataBytes", rule: "range" },
  },
  {
    name: "file count relation before byte relation and selected ceiling",
    input: { archiveBytes: 8_388_609, limits: { maxEntries: 1, maxTotalBytes: 0 } },
    expected: { kind: "refused", field: "maxFiles", rule: "relation" },
  },
  {
    name: "byte relation before selected ceiling",
    input: { archiveBytes: 8_388_609, limits: { maxTotalBytes: 0 } },
    expected: { kind: "refused", field: "maxFileBytes", rule: "relation" },
  },
];
test.each(precedenceCases)("$name", ({ input, expected }) => {
  if (expected.kind !== "refused") throw new Error("expected refusal case");
  expect(planSelectedArchive(input)).toEqual(refusalResult(expected.field, expected.rule));
});

const nonRecords: readonly unknown[] = [undefined, false, 1, "1", () => 1, new Date(0), new Map()];
test.each(nonRecords)("rejects non-record input %p", (input) => {
  expect(planSelectedArchive(input)).toEqual(refusalResult("input", "shape"));
});
test.each(
  nonRecords
    .filter((value) => value !== undefined)
    .concat([[]])
    .map((limits) => ({ limits })),
)("rejects non-record limits $limits", ({ limits }) => {
  expect(planSelectedArchive({ archiveBytes: 1, limits })).toEqual(
    refusalResult("limits", "shape"),
  );
});

test("undefined limits use defaults and null-prototype records are accepted", () => {
  const omitted = planSelectedArchive({ archiveBytes: 1, limits: undefined });
  expect(omitted.kind).toBe("admitted");
  if (omitted.kind !== "admitted") return;
  expect(omitted.plan.limits).toEqual(ceilingLimits);
  const input: Record<string, unknown> = Object.create(null);
  input.archiveBytes = 1;
  expect(planSelectedArchive(input).kind).toBe("admitted");
});

test("unknown symbol keys refuse at their shape boundary", () => {
  expect(planSelectedArchive({ archiveBytes: 1, [Symbol("extra")]: 1 })).toEqual(
    refusalResult("input", "shape"),
  );
  expect(planSelectedArchive({ archiveBytes: 1, limits: { [Symbol("extra")]: 1 } })).toEqual(
    refusalResult("limits", "shape"),
  );
});
