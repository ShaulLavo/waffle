// Original browser adapter: terminal destinations are host sinks, not shared pipe rings.
import { OpenDescription, type DescriptorTable, type Stream } from "../core/descriptors.js";
import {
  createMachineIdFile,
  createNullDevice,
  isValidMachineId,
  shareMachineIdOffset,
} from "../core/devices.js";
import { guardedStream } from "./guarded-stream.js";
import { ProcessError } from "../proc/types.js";
import type { WorkerDescriptorCodec } from "../proc/worker-client.js";
import {
  isSharedArrayBuffer,
  WeakMapConstructor,
  weakMapGet,
  weakMapHas,
  weakMapSet,
} from "../proc/intrinsics.ts";
import { hostTerminalStream, type RuntimeTerminalOutput } from "./terminal-output.js";

type TerminalTarget = 0 | 1 | 2;
interface TerminalToken {
  kind: "web-terminal";
  target: TerminalTarget;
  /** The destination is presented to guests as a pipe, as captured output is on Unix. */
  pipe?: true;
}
interface NullDeviceToken {
  kind: "null-device";
  fdflags: number;
}
interface MachineIdFileToken {
  kind: "machine-id-file";
  machineId: string;
  offset: SharedArrayBuffer;
  fdflags: number;
}
// A remapped fd is not a new destination. Imported terminals retain their provenance across
// codec instances and later generations; WeakMap entries disappear with their local streams.
const targets = new WeakMapConstructor<Stream, TerminalTarget>();
// Host destinations a guest sees as pipes. They keep their target, so their writes still reach
// the same host output, but fd_kind and fdstat report a pipe and isatty is false.
const pipeDestinations = new WeakMapConstructor<Stream, true>();
const NOSYS = 52;

/** A pipe-kind stream at fd `target` that a codec exports as that host destination. */
export function hostPipeDestination(target: TerminalTarget, stream: Stream): Stream {
  if (stream.kind !== "pipe") throw new TypeError("host pipe destination must be a pipe");
  weakMapSet(targets, stream, target);
  weakMapSet(pipeDestinations, stream, true);
  return stream;
}
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
function hasTokenKind(value: unknown, kind: string): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === kind;
}

function validateFdflags(value: Record<string, unknown>, label: string): number {
  const fdflags = value.fdflags;
  if (typeof fdflags !== "number" || !Number.isInteger(fdflags) || fdflags < 0 || fdflags > 31)
    throw new TypeError(`invalid ${label} flags`);
  return fdflags;
}

function nullDeviceToken(value: unknown): NullDeviceToken | undefined {
  if (!hasTokenKind(value, "null-device")) return;
  validateFdflags(value, "null device");
  return value as unknown as NullDeviceToken;
}

function machineIdFileToken(value: unknown): MachineIdFileToken | undefined {
  if (!hasTokenKind(value, "machine-id-file")) return;
  const machineId = value.machineId;
  if (typeof machineId !== "string" || !isValidMachineId(machineId))
    throw new TypeError("invalid machine-id file token");
  const offset = value.offset;
  if (!isSharedArrayBuffer(offset) || offset.byteLength < 4)
    throw new TypeError("invalid machine-id file offset");
  validateFdflags(value, "machine-id file");
  return value as unknown as MachineIdFileToken;
}

function terminalToken(value: unknown): TerminalToken | undefined {
  if (!hasTokenKind(value, "web-terminal")) return;
  if (value.target !== 0 && value.target !== 1 && value.target !== 2)
    throw new TypeError("invalid browser terminal target");
  if ("pipe" in value && value.pipe !== true) throw new TypeError("invalid browser terminal kind");
  return value as unknown as TerminalToken;
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
      if (resource.kind === "device" && resource.device === "null")
        return { kind: "null-device", fdflags: resource.fdflags ?? 0 } satisfies NullDeviceToken;
      if (resource.kind === "device" && resource.device === "machine-id" && resource.virtualFile)
        return {
          kind: "machine-id-file",
          machineId: resource.virtualFile.machineId,
          offset: shareMachineIdOffset(resource.virtualFile),
          fdflags: resource.fdflags ?? 0,
        } satisfies MachineIdFileToken;
      if (resource.kind !== "terminal" && resource.kind !== "pipe")
        return options.fallback.export(descriptor, pid);
      const target = weakMapGet(targets, resource);
      if (target === undefined && resource.kind === "pipe")
        return options.fallback.export(descriptor, pid);
      // Arbitrary callback terminals cannot be cloned: only known destination provenance
      // transfers. A receiving executor may resolve that destination to an interactive stream.
      if (target === undefined)
        throw new ProcessError(NOSYS, "terminal has no transferable browser destination");
      if (weakMapHas(pipeDestinations, resource))
        return { kind: "web-terminal", target, pipe: true } satisfies TerminalToken;
      return { kind: "web-terminal", target } satisfies TerminalToken;
    },
    import(value, pid) {
      const nullDevice = nullDeviceToken(value);
      if (nullDevice) return new OpenDescription(createNullDevice(nullDevice.fdflags));
      const machineIdFile = machineIdFileToken(value);
      if (machineIdFile)
        return new OpenDescription(
          createMachineIdFile(machineIdFile.machineId, machineIdFile.fdflags, machineIdFile.offset),
        );
      const token = terminalToken(value);
      if (!token) return options.fallback.import(value, pid);
      // A pipe destination is never an interactive terminal, so it never resolves to one.
      if (token.pipe) {
        const stream = hostTerminalStream(
          token.target,
          options.output,
          options.checkActive,
          "pipe",
        );
        return new OpenDescription(hostPipeDestination(token.target, stream));
      }
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
      if (nullDeviceToken(value) || machineIdFileToken(value) || terminalToken(value)) return;
      options.fallback.discard(value);
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
