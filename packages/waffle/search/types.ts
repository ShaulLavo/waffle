import type { WalkPlan } from "../fs/walk.js";

export interface SearchPlan {
  readonly tool: "rg" | "grep";
  readonly operands: readonly string[];
  readonly walk: WalkPlan;
  readonly matcher: MatcherPlan;
  readonly output: OutputPlan;
}

export type MatcherPlan =
  | { readonly kind: "literal"; readonly patterns: readonly string[]; readonly ignoreCase: boolean }
  | { readonly kind: "regex"; readonly source: string; readonly ignoreCase: boolean };

export type OutputPlan =
  | { readonly kind: "lines"; readonly lineNumbers: boolean; readonly withFilename: boolean }
  | { readonly kind: "count"; readonly withFilename: boolean; readonly zeroCounts: boolean }
  | { readonly kind: "files-with-matches" };

/** @public Bundler-emitted worker URLs supplied by search program consumers. */
export interface SearchWorkers {
  readonly search: string;
  readonly shard: string;
}

export type MatcherAdmission =
  | { readonly kind: "supported"; readonly matcher: CompiledMatcher }
  | { readonly kind: "fallback"; readonly reason: string };

export interface CompiledMatcher {
  readonly tool: SearchPlan["tool"];
  readonly needles: readonly CompiledNeedle[];
  readonly fold: "none" | "ascii" | "rg-unicode" | "grep-utf8";
}

export interface CompiledNeedle {
  readonly bytes: Uint8Array;
  readonly failure: Uint16Array;
}

export interface FileSearchResult {
  readonly matched: number;
  readonly output: Uint8Array | null;
}

export const SEARCH_LIMITS = {
  patternBytes: 4096,
  patterns: 64,
  fileBytes: 16 * 1024 * 1024,
  outputBytes: 32 * 1024 * 1024,
  pathBytes: 4096,
} as const;
