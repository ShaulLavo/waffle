export type { SearchPlan, MatcherPlan, OutputPlan } from "./types.js";
export type { SearchWorkerRequest } from "./engine.js";
export { compileMatcher } from "./matcher.js";
export { compileGlob } from "../fs/glob.js";
export type { WalkPlan, GlobPattern } from "../fs/walk.js";

export interface SearchWorkers {
  readonly search: string;
  readonly shard: string;
}
