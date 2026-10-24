const importPlan: unique symbol = Symbol("importPlan");

export interface ImportLimits {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxMetadataBytes: number;
}

interface ImportLimitPlan {
  readonly [importPlan]: true;
  readonly archiveBytes: number;
  readonly limits: Readonly<ImportLimits>;
}

export interface ImportInputError {
  readonly kind: "input";
  readonly field: "input" | "archiveBytes" | "limits" | keyof ImportLimits;
  readonly rule: "shape" | "integer" | "range" | "relation";
}

export type ImportLimitAdmission =
  | { readonly kind: "admitted"; readonly plan: ImportLimitPlan }
  | { readonly kind: "refused"; readonly refusal: ImportInputError };

type InputRecord = Record<string, unknown>;
type LimitSpec = Readonly<{
  readonly defaultValue: number;
  readonly minimum: number;
  readonly ceiling: number;
}>;

const LIMIT_SPECS = Object.freeze({
  maxArchiveBytes: Object.freeze({ defaultValue: 8_388_608, minimum: 1, ceiling: 8_388_608 }),
  maxEntries: Object.freeze({ defaultValue: 256, minimum: 1, ceiling: 256 }),
  maxFiles: Object.freeze({ defaultValue: 128, minimum: 0, ceiling: 128 }),
  maxFileBytes: Object.freeze({ defaultValue: 4_194_304, minimum: 0, ceiling: 4_194_304 }),
  maxTotalBytes: Object.freeze({ defaultValue: 4_194_304, minimum: 0, ceiling: 4_194_304 }),
  maxMetadataBytes: Object.freeze({ defaultValue: 262_144, minimum: 1, ceiling: 262_144 }),
}) satisfies Readonly<Record<keyof ImportLimits, LimitSpec>>;

function isRecord(value: unknown): value is InputRecord {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function refusal(
  field: ImportInputError["field"],
  rule: ImportInputError["rule"],
): ImportInputError {
  return { kind: "input", field, rule };
}

function hasInputShape(input: InputRecord): boolean {
  for (const key of Reflect.ownKeys(input)) {
    if (key !== "archiveBytes" && key !== "limits") return false;
  }
  return true;
}

function hasLimitShape(limits: InputRecord): boolean {
  for (const key of Reflect.ownKeys(limits)) {
    switch (key) {
      case "maxArchiveBytes":
      case "maxEntries":
      case "maxFiles":
      case "maxFileBytes":
      case "maxTotalBytes":
      case "maxMetadataBytes":
        break;
      default:
        return false;
    }
  }
  return true;
}

function validateArchiveBytes(value: unknown): number | ImportInputError {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    return refusal("archiveBytes", "integer");
  if (value < 1) return refusal("archiveBytes", "range");
  return value;
}

function resolveLimit(
  limits: InputRecord | undefined,
  field: keyof ImportLimits,
  spec: LimitSpec,
): number | ImportInputError {
  if (limits === undefined || !Object.hasOwn(limits, field) || limits[field] === undefined)
    return spec.defaultValue;
  const value = limits[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return refusal(field, "integer");
  if (value < spec.minimum || value > spec.ceiling) return refusal(field, "range");
  return value;
}

function resolveLimits(limits: InputRecord | undefined): Readonly<ImportLimits> | ImportInputError {
  const maxArchiveBytes = resolveLimit(limits, "maxArchiveBytes", LIMIT_SPECS.maxArchiveBytes);
  if (typeof maxArchiveBytes !== "number") return maxArchiveBytes;

  const maxEntries = resolveLimit(limits, "maxEntries", LIMIT_SPECS.maxEntries);
  if (typeof maxEntries !== "number") return maxEntries;

  const maxFiles = resolveLimit(limits, "maxFiles", LIMIT_SPECS.maxFiles);
  if (typeof maxFiles !== "number") return maxFiles;

  const maxFileBytes = resolveLimit(limits, "maxFileBytes", LIMIT_SPECS.maxFileBytes);
  if (typeof maxFileBytes !== "number") return maxFileBytes;

  const maxTotalBytes = resolveLimit(limits, "maxTotalBytes", LIMIT_SPECS.maxTotalBytes);
  if (typeof maxTotalBytes !== "number") return maxTotalBytes;

  const maxMetadataBytes = resolveLimit(limits, "maxMetadataBytes", LIMIT_SPECS.maxMetadataBytes);
  if (typeof maxMetadataBytes !== "number") return maxMetadataBytes;

  return Object.freeze({
    maxArchiveBytes,
    maxEntries,
    maxFiles,
    maxFileBytes,
    maxTotalBytes,
    maxMetadataBytes,
  });
}

function createPlan(archiveBytes: number, limits: Readonly<ImportLimits>): ImportLimitPlan {
  return Object.freeze({ [importPlan]: true, archiveBytes, limits } satisfies ImportLimitPlan);
}

export function planSelectedArchive(input: unknown): ImportLimitAdmission {
  if (!isRecord(input) || !hasInputShape(input))
    return { kind: "refused", refusal: refusal("input", "shape") };

  const archiveBytes = validateArchiveBytes(input.archiveBytes);
  if (typeof archiveBytes !== "number") return { kind: "refused", refusal: archiveBytes };

  const rawLimits = input.limits;
  if (rawLimits !== undefined && !isRecord(rawLimits))
    return { kind: "refused", refusal: refusal("limits", "shape") };
  if (rawLimits !== undefined && !hasLimitShape(rawLimits))
    return { kind: "refused", refusal: refusal("limits", "shape") };

  const limits = resolveLimits(rawLimits);
  if ("kind" in limits) return { kind: "refused", refusal: limits };
  if (limits.maxFiles > limits.maxEntries - 1)
    return { kind: "refused", refusal: refusal("maxFiles", "relation") };
  if (limits.maxFileBytes > limits.maxTotalBytes)
    return { kind: "refused", refusal: refusal("maxFileBytes", "relation") };
  if (archiveBytes > limits.maxArchiveBytes)
    return { kind: "refused", refusal: refusal("archiveBytes", "range") };

  return { kind: "admitted", plan: createPlan(archiveBytes, limits) };
}
