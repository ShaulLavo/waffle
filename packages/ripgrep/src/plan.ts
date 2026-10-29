import type { SearchPlan } from "../../waffle/search/types.js";

export type RgPlanAdmission =
  | { readonly kind: "supported"; readonly plan: SearchPlan }
  | { readonly kind: "fallback"; readonly reason: string };

export function planRg(
  _argv: readonly string[],
  _env: Readonly<Record<string, string | undefined>> = {},
): RgPlanAdmission {
  return { kind: "fallback", reason: "planner implementation pending" };
}
