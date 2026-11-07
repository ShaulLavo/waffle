import { OrderedReporter } from "./ordered-reporter.js";
import type { Body } from "./protocol.js";
export type { Observation } from "./ordered-reporter.js";
export class Reporter extends OrderedReporter<Body> {
  constructor(
    run: string,
    post?: (input: string, init: RequestInit) => Promise<Response>,
    retryMs?: number,
  ) {
    super(run, post, retryMs);
    window.__pageRunner = this.observation;
  }
  async readyForRetirement(): Promise<void> {
    const url = `/retire?run=${encodeURIComponent(this.run)}&doc=${encodeURIComponent(this.observation.doc)}`;
    while (!this.observation.retired) {
      const response = await this.post(url, { signal: this.clock.abortTimeout(2000) });
      const command: unknown = await response.json();
      if (command === true) {
        await this.send({ kind: "retire-ready" });
        return;
      }
      await new Promise((resolve) => this.clock.timeout(resolve, 50));
    }
  }
}
