// Original browser adapter: terminal destinations are host sinks, not shared pipe rings.
import { OpenDescription, type DescriptorTable, type Stream } from "../core/descriptors.js";
import { guardedStream } from "./guarded-stream.js";
import { ProcessError } from "../proc/types.js";
import type { WorkerDescriptorCodec } from "../proc/worker-client.js";
import { WeakMapConstructor, weakMapGet, weakMapHas, weakMapSet } from "../proc/intrinsics.ts";
import { hostTerminalStream, type RuntimeTerminalOutput } from "./terminal-output.js";

type TerminalTarget = 0 | 1 | 2;
interface TerminalToken {
  kind: "web-terminal";
  target: TerminalTarget;
}
// A remapped fd is not a new destination. Imported terminals retain their provenance across
// codec instances and later generations; WeakMap entries disappear with their local streams.
const targets = new WeakMapConstructor<Stream, TerminalTarget>();
const NOSYS = 52;
export interface RuntimeTerminalCodecOptions {
  fallback: WorkerDescriptorCodec;
  /** Initial default stdio only. Existing imported provenance wins over the current fd number. */
  descriptors?: DescriptorTable;
  /** Host destination for unresolved terminal targets. Writes report exactly what it accepted. */
  output?: RuntimeTerminalOutput;
  /** Resolve inherited provenance to a process-local endpoint, including interactive stdin.
   * Return undefined to keep this target's default EOF input or host output.
   * The returned stream is owned by the imported description and closed at its last release. */
  resolveTerminal?(target: TerminalTarget): Stream | undefined;
  checkActive?(): void;
}
function terminalToken(value: unknown): TerminalToken | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== "web-terminal"
  )
    return;
  if (!("target" in value) || (value.target !== 0 && value.target !== 1 && value.target !== 2))
    throw new TypeError("invalid browser terminal target");
  return value as TerminalToken;
}
function resolveTerminal(
  options: RuntimeTerminalCodecOptions,
  target: TerminalTarget,
): Stream | undefined {
  if (!options.resolveTerminal) return;
  options.checkActive?.();
  const stream = options.resolveTerminal(target);
  try {
    options.checkActive?.();
  } catch (error) {
    stream?.close?.();
    throw error;
  }
  return stream;
}
export function createRuntimeTerminalCodec(
  options: RuntimeTerminalCodecOptions,
): WorkerDescriptorCodec {
  for (const fd of [0, 1, 2] as const) {
    const resource = options.descriptors?.get(fd)?.resource;
    if (resource?.kind === "terminal" && !weakMapHas(targets, resource))
      weakMapSet(targets, resource, fd);
  }
  return {
    export(descriptor, pid) {
      const resource = descriptor.resource;
      if (resource.kind !== "terminal" && resource.kind !== "pipe")
        return options.fallback.export(descriptor, pid);
      const target = weakMapGet(targets, resource);
      if (target === undefined && resource.kind === "pipe")
        return options.fallback.export(descriptor, pid);
      // Arbitrary callback terminals cannot be cloned: only known destination provenance
      // transfers. A receiving executor may resolve that destination to an interactive stream.
      if (target === undefined)
        throw new ProcessError(NOSYS, "terminal has no transferable browser destination");
      return { kind: "web-terminal", target } satisfies TerminalToken;
    },
    import(value, pid) {
      const token = terminalToken(value);
      if (!token) return options.fallback.import(value, pid);
      const resolved = resolveTerminal(options, token.target);
      if (resolved !== undefined) {
        const remember = (stream: Stream) => {
          weakMapSet(targets, stream, token.target);
        };
        const stream = options.checkActive
          ? guardedStream(resolved, options.checkActive, remember)
          : resolved;
        remember(stream);
        return new OpenDescription(stream, () => stream.close?.());
      }
      const stream = hostTerminalStream(token.target, options.output, options.checkActive);
      weakMapSet(targets, stream, token.target);
      return new OpenDescription(stream);
    },
    discard(value) {
      // The token carries a stateless destination, not a retained filesystem or pipe reference.
      if (!terminalToken(value)) options.fallback.discard(value);
    },
  };
}

export type { RuntimeTerminalOutput } from "./terminal-output.js";
export { captureTerminalProcessLifetime } from "./terminal-lifetime.js";
export type { TerminalProcessLifetime } from "./terminal-lifetime.js";
export {
  createTerminalInput,
  attachTerminalInput,
  pushTerminalInput,
  createTerminalInputPolicy,
} from "./terminal-input.js";
export type {
  TerminalInput,
  TerminalInputObservation,
  TerminalInputPolicyOptions,
  TerminalInputPushResult,
} from "./terminal-input.js";
export {
  createTerminalSession,
  claimTerminalAuthority,
  attachTerminal,
  terminalControls,
  TERMINAL_SESSION_LIMITS,
} from "./terminal-session.js";
export type {
  TerminalIdentity,
  TerminalContext,
  TerminalGroup,
  TerminalMember,
  TerminalMemberPlan,
  TerminalLease,
  TerminalSelection,
  TerminalMode,
  TerminalTarget,
  TerminalReason,
  TerminalFailure,
  TerminalResult,
  TerminalGeometry,
  TerminalGeometrySnapshot,
  TerminalSnapshot,
  TerminalTurn,
  TerminalChange,
  TerminalPolicy,
  TerminalDisplay,
  TerminalPlannedMember,
  TerminalAdmittedMember,
  TerminalMemberUpdate,
  TerminalAuthority,
  TerminalControlOptions,
  TerminalControlTurn,
  TerminalControlReceipt,
  TerminalControlResult,
  TerminalControlState,
  TerminalGroupStatus,
  TerminalMemberStatus,
  TerminalGeometrySubscription,
  TerminalControls,
  TerminalAttachment,
} from "./terminal-session.js";
