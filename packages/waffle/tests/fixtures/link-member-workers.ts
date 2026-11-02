import type { MemberLease, MemoryGroups } from "../../group/state.js";

type MemberResource =
  | { readonly kind: "reserved"; readonly lease: MemberLease }
  | { readonly kind: "started"; readonly lease: MemberLease; readonly worker: Worker };
type StartedMember = Extract<MemberResource, { kind: "started" }>;
interface MemberOptions {
  readonly groups: MemoryGroups;
  readonly pid: number;
  readonly program: string;
  readonly join: Parameters<MemoryGroups["admit"]>[2];
  readonly workerURL: URL;
}
interface ScopeOptions {
  readonly createWorker?: (url: URL) => Worker;
  readonly beforeStopped?: () => void;
  readonly afterClosed?: () => void;
}
function createWorker(url: URL): Worker {
  return new Worker(url.href);
}
function startMember(
  resources: MemberResource[],
  options: MemberOptions,
  construct: (url: URL) => Worker,
): StartedMember {
  const lease = options.groups.admit(options.pid, options.program, options.join);
  const index = resources.push({ kind: "reserved", lease }) - 1;
  const worker = construct(options.workerURL);
  const member: StartedMember = { kind: "started", lease, worker };
  resources[index] = member;
  return member;
}
async function stopMember(member: MemberResource, beforeStopped?: () => void): Promise<void> {
  if (member.kind === "reserved") {
    member.lease.stopped();
    return;
  }
  try {
    member.worker.postMessage({ kind: "close" });
  } finally {
    await member.worker.terminate();
    try {
      beforeStopped?.();
    } finally {
      member.lease.stopped();
    }
  }
}
async function stopMembers(resources: MemberResource[], options: ScopeOptions): Promise<void> {
  const results = await Promise.allSettled(
    resources.map((member) => stopMember(member, options.beforeStopped)),
  );
  const failures: unknown[] = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Member fixture cleanup failed");
  options.afterClosed?.();
}
export async function withMemberWorkers<T>(
  work: (start: (options: MemberOptions) => StartedMember) => Promise<T>,
  options: ScopeOptions = {},
): Promise<T> {
  const resources: MemberResource[] = [];
  try {
    return await work((input) =>
      startMember(resources, input, options.createWorker ?? createWorker),
    );
  } finally {
    await stopMembers(resources, options);
  }
}
