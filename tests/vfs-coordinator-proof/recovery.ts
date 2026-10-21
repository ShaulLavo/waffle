import { checkRequestBytes, mutation, type Cursor, type Reply, type Request } from "./protocol.js";

export interface AcceptedAuthority {
  instance: string;
  token: string;
  cursor: Cursor;
}
export type AuthorityState =
  | { kind: "detached" }
  | { kind: "recovering"; instance: string | undefined; previous: AcceptedAuthority | undefined }
  | { kind: "current"; accepted: AcceptedAuthority }
  | { kind: "replacement"; instance: string; previous: AcceptedAuthority | undefined }
  | {
      kind: "unavailable";
      instance: string | undefined;
      previous: AcceptedAuthority | undefined;
      reason: string;
    };

export function accepted(state: AuthorityState): AcceptedAuthority | undefined {
  return state.kind === "current"
    ? state.accepted
    : "previous" in state
      ? state.previous
      : undefined;
}
export function observed(state: AuthorityState): string | undefined {
  return state.kind === "current"
    ? state.accepted.instance
    : "instance" in state
      ? state.instance
      : undefined;
}
export function greeting(state: AuthorityState, instance: string): AuthorityState {
  if (observed(state) === instance) return state;
  if (state.kind === "recovering" && state.instance === undefined) return { ...state, instance };
  return { kind: "replacement", instance, previous: accepted(state) };
}
export function beginRecovery(state: AuthorityState): AuthorityState {
  return { kind: "recovering", instance: observed(state), previous: accepted(state) };
}
export function acceptRecovery(state: AuthorityState, value: AcceptedAuthority): AuthorityState {
  if (state.kind !== "recovering" || state.instance !== value.instance)
    throw new Error("FENCED: recovery instance changed");
  const previous = state.previous;
  if (
    previous &&
    value.instance !== previous.instance &&
    value.cursor.epoch <= previous.cursor.epoch
  )
    throw new Error("FENCED: replacement did not advance authority epoch");
  return { kind: "current", accepted: value };
}
export function accepts(state: AuthorityState, instance: string, reply: Reply): boolean {
  if (state.kind !== "current" || state.accepted.instance !== instance) return false;
  return reply.kind !== "ok" || reply.cursor.epoch === state.accepted.cursor.epoch;
}
export function unsettled(request: Request | undefined, reason: string): Reply {
  const code = request && mutation(request.operation) ? "OUTCOME_UNKNOWN" : "UNAVAILABLE";
  return { kind: "error", code, message: `${code}: ${reason}; not cancelled or replayed` };
}
export class IntentLedger {
  readonly intents = new Map<
    string,
    { request: Request; fingerprint: string; outcome: "issued" | "unknown" | "resolved" }
  >();
  capture(input: Request): Request {
    checkRequestBytes(input);
    const request = structuredClone(input);
    if (!mutation(request.operation)) return request;
    const key = `${request.client}:${request.sequence}`;
    const fingerprint = JSON.stringify({ actor: request.actor, operation: request.operation });
    const previous = this.intents.get(key);
    if (previous && previous.fingerprint !== fingerprint)
      throw new Error("OP_ID_CONFLICT: payload mismatch");
    if (!previous && this.intents.size >= 256) throw new Error("BACKPRESSURE: intent budget");
    if (!previous)
      this.intents.set(key, { request: structuredClone(request), fingerprint, outcome: "issued" });
    return request;
  }
  settle(request: Request, reply: Reply): void {
    const intent = this.intents.get(`${request.client}:${request.sequence}`);
    if (!intent) return;
    intent.outcome = reply.kind === "ok" ? "resolved" : "unknown";
  }
  unresolved(): string[] {
    return Array.from(this.intents)
      .filter(([, intent]) => intent.outcome !== "resolved")
      .map(([key]) => key);
  }
}
