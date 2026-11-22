import * as production from "../../proc/pipes.js";
import { isolatedPipes } from "./pipes-intrinsics.ts";

/** Every named step boundary in proc/pipes.ts, in the order an operation reaches them. */
export const PIPE_PAUSE_POINTS = [
  "write.loaded",
  "write.record",
  "map.loaded",
  "pool.admitted",
  "write.reserved",
  "write.copied",
  "write.failed",
  "read.loaded",
  "read.copied",
  "read.committed",
  "release.page",
  "sweep.cursors",
  "sweep.entry",
  "scavenge.ring",
  "relay.recover",
  "relay.head",
  "relay.staged",
  "relay.deliver",
  "reclaim.advanced",
] as const;
export type PipePausePoint = (typeof PIPE_PAUSE_POINTS)[number];
type Pipes = typeof production;
type Endpoint = ReturnType<InstanceType<Pipes["PipeController"]>["retain"]>;

interface Pause {
  point: PipePausePoint;
  /** Fire on this hit of the point, counting from when the pause was armed (1 = first). */
  hit: number;
  seen: number;
  run: () => void;
}

/** One module instance of proc/pipes.ts, standing in for one Worker or the page. Pipe code
 * keeps per-realm scratch, so a party that runs while another is paused must live in its own
 * realm, as it would in production. `pause` runs a callback when this realm reaches a named
 * point; the callback usually drives the other realm, which runs to completion before the
 * paused party resumes. Each pause fires once. */
export class PipeRealm {
  readonly pipes: Pipes;
  readonly atomics: typeof Atomics;
  /** Hits per point over this realm's life, for coverage reports. */
  readonly hits = new Map<string, number>();
  private readonly pauses: Pause[] = [];
  private running = false;
  constructor() {
    const isolated = isolatedPipes();
    this.pipes = isolated.pipes as unknown as Pipes;
    this.atomics = isolated.atomics;
    isolated.hooks.pipePause = (point) => this.reached(point);
  }
  pause(point: PipePausePoint, run: () => void, hit = 1): void {
    this.pauses.push({ point, hit, seen: 0, run });
  }
  /** Whether every armed pause has fired. */
  get settled(): boolean {
    return this.pauses.length === 0;
  }
  clear(): void {
    this.pauses.length = 0;
  }
  /** Re-home an endpoint in this realm, as a structured-cloned handle sent to a Worker would. */
  adopt(endpoint: Endpoint): Endpoint {
    return this.pipes.attachPipeEndpoint(structuredClone(endpoint.handle()));
  }
  private reached(point: string): void {
    this.hits.set(point, (this.hits.get(point) ?? 0) + 1);
    if (this.running) return;
    let index = -1;
    for (const [at, pause] of this.pauses.entries()) {
      if (pause.point !== point) continue;
      pause.seen++;
      if (index < 0 && pause.seen === pause.hit) index = at;
    }
    if (index < 0) return;
    const [pause] = this.pauses.splice(index, 1);
    this.running = true;
    try {
      pause!.run();
    } finally {
      this.running = false;
    }
  }
}

/** A realm with no pause hooks: the production module itself. */
export const plainRealm = {
  pipes: production,
  adopt(endpoint: Endpoint): Endpoint {
    return production.attachPipeEndpoint(structuredClone(endpoint.handle()));
  },
};
