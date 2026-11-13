type Value =
  | { kind: "scalar"; value: string | boolean | null }
  | { kind: "number" | "bigint"; value: string }
  | { kind: "undefined" }
  | { kind: "uint8array"; value: number[] }
  | { kind: "array"; value: Value[] }
  | { kind: "object"; value: [string, Value][] };

export function encodeCrossTabValue(value: unknown): Value {
  if (value === undefined) return { kind: "undefined" };
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return { kind: "scalar", value };
  if (typeof value === "number")
    return { kind: "number", value: Object.is(value, -0) ? "-0" : String(value) };
  if (typeof value === "bigint") return { kind: "bigint", value: String(value) };
  if (value instanceof Uint8Array && value.buffer instanceof ArrayBuffer)
    return { kind: "uint8array", value: Array.from(value) };
  if (Array.isArray(value)) return { kind: "array", value: value.map(encodeCrossTabValue) };
  if (typeof value !== "object" || ![null, Object.prototype].includes(Object.getPrototypeOf(value)))
    throw new Error(`Unsupported cross-tab value ${Object.prototype.toString.call(value)}`);
  return {
    kind: "object",
    value: Object.entries(value).map(([key, item]) => [key, encodeCrossTabValue(item)]),
  };
}

export function decodeCrossTabValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("kind" in value))
    throw new Error("Invalid cross-tab value");
  if (value.kind === "undefined") return undefined;
  if (!("value" in value)) throw new Error("Missing cross-tab value");
  const payload = value.value;
  if (
    value.kind === "scalar" &&
    (payload === null || typeof payload === "string" || typeof payload === "boolean")
  )
    return payload;
  if (value.kind === "bigint" && typeof payload === "string") return BigInt(payload);
  if (value.kind === "number" && typeof payload === "string") return Number(payload);
  if (value.kind === "array" && Array.isArray(payload)) return payload.map(decodeCrossTabValue);
  if (
    value.kind === "uint8array" &&
    Array.isArray(payload) &&
    payload.every(
      (byte: unknown) =>
        typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255,
    )
  )
    return Uint8Array.from(payload);
  if (value.kind !== "object" || !Array.isArray(payload))
    throw new Error("Invalid cross-tab value kind");
  return Object.fromEntries(
    payload.map((entry: unknown) => {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string")
        throw new Error("Invalid cross-tab object entry");
      return [entry[0], decodeCrossTabValue(entry[1])];
    }),
  );
}
