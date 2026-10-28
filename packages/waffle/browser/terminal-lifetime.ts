import {
  captureTerminalLifetime,
  type TerminalProcessLifetime,
} from "../proc/terminal-lifetime.js";
import type { WorkerProcessTransport } from "../proc/worker-client.js";
import { terminalStopCapture, type TerminalIdentity } from "./terminal-session.js";
import { attachTerminalInput, poisonTerminalInput, type TerminalInput } from "./terminal-input.js";
import { arrayAppend } from "../proc/intrinsics.js";

export type { TerminalProcessLifetime } from "../proc/terminal-lifetime.js";

function inputDeath(inputs: readonly TerminalInput[]): (nonce: bigint, token: bigint) => void {
  const retained: TerminalInput[] = [];
  for (let index = 0; index < inputs.length; index++)
    arrayAppend(retained, attachTerminalInput(inputs[index]!.buffer));
  return (nonce, token) => {
    for (let index = 0; index < retained.length; index++)
      if (poisonTerminalInput(retained[index]!, nonce, token)) return;
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
  const captures: (() => void)[] = [];
  for (let index = 0; index < options.terminals.length; index++) {
    const terminal = options.terminals[index]!;
    const stopped = terminalStopCapture(terminal.identity, options.process);
    const poison = inputDeath(terminal.inputs);
    arrayAppend(captures, () => stopped(poison));
  }
  return captureTerminalLifetime(options.process, () => {
    for (let index = 0; index < captures.length; index++) captures[index]!();
  });
}
