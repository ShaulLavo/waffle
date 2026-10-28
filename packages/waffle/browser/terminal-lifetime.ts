import {
  captureTerminalLifetime,
  type TerminalProcessLifetime,
} from "../proc/terminal-lifetime.js";
import type { WorkerProcessTransport } from "../proc/worker-client.js";
import { terminalStopCapture, type TerminalIdentity } from "./terminal-session.js";
import { poisonTerminalInput, type TerminalInput } from "./terminal-input.js";

export type { TerminalProcessLifetime } from "../proc/terminal-lifetime.js";

function inputDeath(inputs: readonly TerminalInput[]): (nonce: bigint, token: bigint) => void {
  const retained = Array.from(inputs);
  return (nonce, token) => {
    if (!retained.some((input) => poisonTerminalInput(input, nonce, token)))
      throw new Error("Interrupted terminal input was omitted from the stop capture");
  };
}

/** Trusted host capture for a native consumer that may stop outside the runtime broker.
 * Include every reachable session and its input transports. Keep this object out of guests. */
export function captureTerminalProcessLifetime(options: {
  readonly process: WorkerProcessTransport;
  readonly terminals: readonly {
    readonly identity: TerminalIdentity;
    readonly inputs: readonly TerminalInput[];
  }[];
}): TerminalProcessLifetime {
  const captures = options.terminals.map(({ identity, inputs }) => {
    const stopped = terminalStopCapture(identity, options.process);
    const poison = inputDeath(inputs);
    return () => stopped(poison);
  });
  return captureTerminalLifetime(options.process, () => {
    for (const stopped of captures) stopped();
  });
}
