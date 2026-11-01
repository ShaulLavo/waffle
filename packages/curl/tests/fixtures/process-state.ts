import { readFileSync } from "node:fs";

export function processState(path: string | number): string | undefined {
  try {
    return readFileSync(path, "utf8").split(") ")[1]?.[0];
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ESRCH")
    )
      return undefined;
    throw error;
  }
}
