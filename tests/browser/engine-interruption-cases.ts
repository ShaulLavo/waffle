// Original harness orchestration: a failed proof does not hide independent cases.
// Cleanup is a separate safety gate, not a proof outcome that can be ignored.
export interface FunctionalCaseIdentity {
  engine: string;
  route: string;
  name: string;
  delivery?: string;
  control?: string;
  trial?: number;
}
export interface FunctionalCaseOutcome extends FunctionalCaseIdentity {
  ok: boolean;
  result?: unknown;
  error?: string;
  context: unknown;
  cleanup: { safe: boolean; error?: string };
}
export class FunctionalCases {
  readonly outcomes: FunctionalCaseOutcome[] = [];
  private unsafe: Error | undefined;
  get ok(): boolean { return this.outcomes.every(outcome => outcome.ok); }
  get safe(): boolean { return !this.unsafe; }
  async run(identity: FunctionalCaseIdentity, run: () => Promise<unknown>, diagnostics: () => unknown, cleanup: () => void | Promise<void>): Promise<FunctionalCaseOutcome> {
    if (this.unsafe) throw this.unsafe;
    const outcome: FunctionalCaseOutcome = { ...identity, ok: false, context: undefined, cleanup: { safe: true } };
    try { outcome.result = await run(); outcome.ok = true; }
    catch (error) { outcome.error = error instanceof Error ? error.stack ?? String(error) : String(error); }
    try { outcome.context = diagnostics(); }
    catch (error) { outcome.context = { diagnosticError: String(error) }; }
    try { await cleanup(); }
    catch (error) {
      outcome.ok = false;
      outcome.cleanup = { safe: false, error: String(error) };
      this.unsafe = new Error(`unsafe functional cleanup (${identity.engine}/${identity.route}/${identity.name}): ${String(error)}`, { cause: error });
    }
    this.outcomes.push(outcome);
    if (this.unsafe) throw this.unsafe;
    return outcome;
  }
}
export async function waitFunctionalCondition(condition: () => boolean, label: string | (() => string), options: {
  completed?: () => boolean;
  aborted?: () => boolean;
  timeoutMs?: number;
  pause?: () => Promise<void>;
  now?: () => number;
} = {}): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const pause = options.pause ?? (() => new Promise<void>(resolve => setTimeout(resolve, 2)));
  const end = now() + (options.timeoutMs ?? 15_000);
  while (!condition()) {
    const description = () => typeof label === "function" ? label() : label;
    if (options.completed?.()) throw new Error(`${description()} cannot complete after guest execution finished`);
    if (options.aborted?.() || now() > end) throw new Error(`${description()} timed out`);
    await pause();
  }
}
export function cleanupFunctionalResources(actions: readonly (() => void)[], report: (error: unknown) => void): void {
  for (const action of actions) {
    try { action(); } catch (error) { report(error); }
  }
}
export function assertGuestQuiescence(guests: readonly { evidence: { startEntered: number; startLeft: number; runReturned: number } }[]): void {
  for (const guest of guests) {
    // Production Bun light has no _start observer, so a failed light proof cannot
    // establish quiescence here. Its logical exit or terminate call is not enough.
    const stopped = guest.evidence.startEntered === 1 && guest.evidence.startLeft === 1 && guest.evidence.runReturned === 1;
    if (!stopped) throw new Error(`guest execution quiescence is unproved after failed case: ${JSON.stringify(guest.evidence)}`);
  }
}
