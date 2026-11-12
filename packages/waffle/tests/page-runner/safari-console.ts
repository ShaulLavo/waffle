import { record } from "./protocol.js";

export function consoleMessage(params: unknown) {
  if (!record(params) || !record(params.message))
    throw new Error("Invalid Inspector console message");
  const m = params.message;
  if (typeof m.source !== "string" || typeof m.level !== "string" || typeof m.text !== "string")
    throw new Error("Invalid Inspector console facts");
  if (m.type !== undefined && typeof m.type !== "string")
    throw new Error("Invalid Inspector console type");
  if (m.url !== undefined && typeof m.url !== "string")
    throw new Error("Invalid Inspector console URL");
  for (const key of ["line", "column", "repeatCount"]) {
    const value = m[key];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    )
      throw new Error(`Invalid Inspector console ${key}`);
  }
  return {
    source: m.source,
    level: m.level,
    text: m.text,
    ...(typeof m.type === "string" ? { type: m.type } : {}),
    ...(typeof m.url === "string" ? { url: m.url } : {}),
    ...(typeof m.line === "number" ? { line: m.line } : {}),
    ...(typeof m.column === "number" ? { column: m.column } : {}),
  };
}
export function consoleFailure(m: ReturnType<typeof consoleMessage>, page: boolean): boolean {
  return m.level === "error" && ((page && m.source === "javascript") || m.type === "log");
}
export function consoleExpired(m: ReturnType<typeof consoleMessage>): boolean {
  return (
    m.source === "other" &&
    m.level === "warning" &&
    /^[1-9][0-9]* console messages are not shown\.$/.test(m.text)
  );
}
