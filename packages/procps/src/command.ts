import type { HostCommand, HostCommandContext, SignalSend } from "waffle/proc/command";
import { planProcps } from "./index.ts";
import type { Command, ProcessRow, SignalPlan } from "./model.ts";

const encoder = new TextEncoder();

export function procpsCommand(command: Command): HostCommand {
  return async (context) => {
    context.abort.throwIfAborted();
    const processes: ProcessRow[] = context.processes.snapshot().map((row) => ({
      pid: row.pid,
      parentPid: row.parentPid,
      comm: row.executable.slice(row.executable.lastIndexOf("/") + 1),
      args: row.argv.join(" "),
    }));
    const plan = planProcps({
      command,
      argv: context.request.argv.slice(1),
      processes,
      selfPid: context.pid,
    });
    if (plan.kind === "signal") return sendSignals(context, plan);
    await write(context, "stdout", plan.stdout);
    await write(context, "stderr", plan.stderr);
    context.abort.throwIfAborted();
    return plan.status;
  };
}

async function write(context: HostCommandContext, stream: "stdout" | "stderr", text: string) {
  if (!text) return;
  const bytes = encoder.encode(text);
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    context.abort.throwIfAborted();
    await context[stream].write(bytes.subarray(offset, offset + 4096));
  }
}

const failures: Record<Exclude<SignalSend, "sent">, string> = {
  missing: "target is missing or has exited",
  denied: "signal permission denied",
  revoked: "delegated signal authority was revoked",
};

async function sendSignals(context: HostCommandContext, plan: SignalPlan): Promise<number> {
  if (!context.signals) {
    await write(context, "stderr", "pkill: delegated signal authority is absent\n");
    return 1;
  }
  let sent = 0;
  for (const pid of plan.pids) {
    context.abort.throwIfAborted();
    const result = context.signals.send(pid, plan.signal);
    if (result === "sent") {
      sent++;
      continue;
    }
    await write(context, "stderr", `pkill: ${pid}: ${failures[result]}\n`);
  }
  context.abort.throwIfAborted();
  return sent > 0 ? 0 : 1;
}
