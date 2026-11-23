/** Host diagnostics have no page-report size limit. Keep the complete error tree. */
export function serializeError(value: unknown, ancestors = new Set<object>()): unknown {
  if (typeof value === "bigint") return String(value);
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[circular]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => serializeError(item, ancestors));
    const fields = errorFields(value);
    return Object.fromEntries(
      Object.entries(fields).map(([key, item]) => [key, serializeError(item, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function errorFields(value: object): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...value };
  if (!(value instanceof Error)) return fields;
  fields.name = value.name;
  fields.message = value.message;
  fields.stack = value.stack;
  if ("cause" in value) fields.cause = value.cause;
  if (value instanceof AggregateError) fields.errors = value.errors;
  return fields;
}

/** Preserve native aggregate identity and children while supporting ordinary JSON output. */
export class SerializableAggregateError extends AggregateError {
  toJSON(): unknown {
    return serializeError(this);
  }
}
