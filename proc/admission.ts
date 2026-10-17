/** Opt-in process admission diagnostics. Reservations and launch requests are not proof that
 * a worker started; only `launched` records successful completion of the adapter launch.
 * `skipped` samples an outcome already selected when admission requests startup; cancellation
 * during module resolution may leave history at `starting`. No teardown lifecycle is reported. */
export interface ProcessAdmissionEvent {
  readonly pid: number;
  readonly parentPid: number;
  readonly job: number;
  /** Opaque shared-directory identity, present for transport-backed events. Never a buffer. */
  readonly directory?: string;
  readonly stage: "received" | "queued" | "reserved" | "bound" | "starting" | "skipped" | "launching" | "launched" | "rejected" | "dropped";
  readonly reason?: "unknown-sender" | "wrong-sender" | "sender-signaled" | "sender-revoked" | "broker-disposed" | "duplicate-process" | "unknown-parent" | "directory-mismatch" | "admission-failed" | "activation-failed" | "reservation-failed" | "binding-failed" | "start-failed" | "external-rejection" | "already-registered" | "preselected-exit" | "preselected-signal";
}
export type ProcessAdmissionObserver = (event: ProcessAdmissionEvent) => void | PromiseLike<void>;

/** Diagnostic observers never own resources, admission decisions, or failure reporting. */
export function reportProcessAdmission(observer: ProcessAdmissionObserver | undefined,
  identity: Pick<ProcessAdmissionEvent, "pid" | "parentPid" | "job">,
  stage: ProcessAdmissionEvent["stage"], reason?: ProcessAdmissionEvent["reason"], directory?: string): void {
  if (!observer) return;
  try {
    const pending = observer(Object.freeze({ pid: identity.pid, parentPid: identity.parentPid, job: identity.job, stage, ...(reason ? { reason } : {}), ...(directory !== undefined ? { directory } : {}) }));
    if (pending) void Promise.resolve(pending).catch(() => {});
  }
  catch { /* Observability must not change process ownership or cleanup. */ }
}
