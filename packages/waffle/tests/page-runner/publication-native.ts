import { nativeMain } from "./native.js";
import { publicationAdapter } from "./publication-suite.js";
import type { PublicationMode } from "../publication-command.js";

export function publicationNative(
  mode: PublicationMode,
  args: string[],
  startedAt: number,
): Promise<number> {
  return nativeMain(publicationAdapter(mode), args, { startedAt });
}
