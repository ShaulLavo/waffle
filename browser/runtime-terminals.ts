// Original browser adapter: terminal destinations are host callbacks, not shared pipe rings.
import { OpenDescription, type DescriptorTable, type Stream } from "../core/descriptors.js";
import { guardedStream } from "./guarded-stream.js";
import { ProcessError } from "../proc/types.js";
import type { WorkerDescriptorCodec } from "../proc/worker-client.js";
import { WeakMapConstructor, weakMapGet, weakMapHas, weakMapSet } from "../proc/intrinsics.ts";

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
  output?(fd: 1 | 2, data: Uint8Array): void;
  /** Resolve inherited provenance to a process-local endpoint, including interactive stdin.
   * The returned stream is owned by the imported description and closed at its last release. */
  resolveTerminal?(target: TerminalTarget): Stream;
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
      if (options.resolveTerminal) {
        options.checkActive?.();
        const resolved = options.resolveTerminal(token.target);
        try {
          options.checkActive?.();
        } catch (error) {
          resolved.close?.();
          throw error;
        }
        const remember = (stream: Stream) => {
          weakMapSet(targets, stream, token.target);
        };
        const stream = options.checkActive
          ? guardedStream(resolved, options.checkActive, remember)
          : resolved;
        remember(stream);
        return new OpenDescription(stream, () => stream.close?.());
      }
      const read = () => {
        options.checkActive?.();
        return 0;
      };
      const write = (chunks: readonly Uint8Array[]) => {
        options.checkActive?.();
        const total = chunks.reduce((size, bytes) => size + bytes.length, 0);
        if (!total) return 0;
        if (!options.output) return -NOSYS;
        // Copy guest memory before posting/transferring; WASM memory is never transferable.
        const data = new Uint8Array(total);
        let offset = 0;
        for (const bytes of chunks) {
          data.set(bytes, offset);
          offset += bytes.length;
        }
        options.output(token.target === 2 ? 2 : 1, data);
        return total;
      };
      const stream: Stream = {
        kind: "terminal",
        read,
        tryRead: read,
        write,
        tryWrite: write,
        readiness() {
          options.checkActive?.();
          return { readable: true, writable: true, hangup: token.target === 0 };
        },
      };
      weakMapSet(targets, stream, token.target);
      return new OpenDescription(stream);
    },
    discard(value) {
      // The token carries a stateless destination, not a retained filesystem or pipe reference.
      if (!terminalToken(value)) options.fallback.discard(value);
    },
  };
}
