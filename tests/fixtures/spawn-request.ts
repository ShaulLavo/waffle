import type { SpawnRequest } from "../../proc/types.js";

/** Small process fixture shared by worker ownership and pipe tests. */
export function fixtureSpawnRequest(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    executable: "fixture",
    argv: ["fixture"],
    env: {},
    cwd: "/",
    job: 0,
    fds: [],
    ...overrides,
  };
}
