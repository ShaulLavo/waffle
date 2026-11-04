import { enterGuest, GuestTerminal, guestProcExit } from "../thread/entry.ts";
import { claimOutcome, reviveOutcome, type OutcomeTransfer } from "../proc/outcome.ts";

self.onmessage = ({
  data,
}: MessageEvent<{
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
  outcome: OutcomeTransfer;
  signal: Int32Array;
  race?: { gate: Int32Array; role: "exit" | "kill" };
}>) => {
  const terminal = new GuestTerminal({
    thread: { directory: "test", pid: 1, tid: 0 },
    outcome: reviveOutcome(data.outcome),
    signal: data.signal,
    report: (report) => self.postMessage(report),
  });
  if (data.race) {
    self.postMessage({ kind: "race-ready" });
    Atomics.wait(data.race.gate, 0, 0);
    if (data.race.role === "kill") {
      claimOutcome(reviveOutcome(data.outcome), { kind: "signaled", code: 9 });
      self.postMessage({ kind: "host-idle" });
      return;
    }
  }
  void enterGuest(
    { kind: "initial" },
    terminal,
    () =>
      new WebAssembly.Instance(data.module, {
        env: { memory: data.memory },
        wasi_snapshot_preview1: { proc_exit: (code: number) => guestProcExit(code, terminal) },
        fixture: { parked: () => self.postMessage({ kind: "parked" }) },
      }),
  );
};
