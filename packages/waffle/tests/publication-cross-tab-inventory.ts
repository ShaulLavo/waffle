export const crossTabId = "publication: complete cross-tab command";
export const crossTabTimeoutMs = 180_000;
export const crossTabLabels = [
  "ordinary native persistent worker same-name reopen, permissions and bytes",
  "pending native claim cancels after real DB open while ordinary worker retains its lock, epoch and bytes",
  "physically pending native request joins actual late delivery and closes before guards release",
  "physically pending native request joins actual late delivery and retains original failed close and guards",
  "granted native epoch retires before cancelled factory closes without adapter load",
  "first-live-holder refused before factory native open/claim/load; readonly inspection unchanged",
  "second-explicit-live-holder refused before factory native open/claim/load; readonly inspection unchanged",
  "private factory same-name explicit v1 reopen, fresh identities, cold namespace bytes/mode and native-close-before-final-guard-release",
  "abort joins a late actual native adapter and never publishes readiness",
  "native continuity release acknowledged after surviving holder page closes",
  "failed native close stays failed; surviving real attachment blocks replacement until genuine realm destruction",
  "ordinary survivor exclusion and post-exposure defensive private-view hooks",
  "independent pages, real runtime_proc writes/append and Preview1 current read, no root SAB transfer, no commit nudge, exact two groups",
  "late open cancellation joins exact session cleanup without detaching successor",
  "stopped late readiness cancels exactly once before guard release, with no captured input or effects",
  "duplicate old cancellation cannot erase the next READY grant from transport status tracking",
  "queued acquisition cancellation joins cleanup and actual cancelled bootstrap never reaches setup",
  "CLAIMED live worker blocks exclusive continuity after creator authority death, creator page close and timeout; separate native worker death releases guard",
  "workspace independent pages, genuine WASI namespace, retained unlink/replacement, current async metadata, real runtime_proc EAGAIN/read/write, lost-nudge complete changes, guest observer denial, codec reservation/shared offsets, permissions, exact duplicate/conflict/own receipts and joined stop",
  "actual workspace startup cancellation and setup failure close their owned bridges",
  "actual workspace exit waits for the native pending authority reply before channel close and exit ACK",
  "actual workspace exit joins codec adoption while the accepted independent child survives and reads",
  "repeated stop/dispose stays revoked and closes once; unaccepted codec reservation cancellation joins separately",
  "observed actual parent cleanup joins later pre-bind child cancellation before closed-once exit ACK",
  "withholding both original terminal deliveries keeps stop and guard pending past the caller deadline; releasing the matching result joins exit and one channel close before guest death",
  "explicit workspace cleanup post failure emits cleanup-error without exit ACK/channel close; native worker death alone releases retained continuity",
];
export function checkCrossTabLabels(value: unknown): void {
  if (
    !Array.isArray(value) ||
    value.length !== crossTabLabels.length ||
    value.some((label, index) => label !== crossTabLabels[index])
  )
    throw new Error("Incomplete or reordered original cross-tab controls");
}

if (import.meta.main)
  console.log(
    JSON.stringify(
      {
        command:
          "bun packages/waffle/tests/publication-cross-tab-browser-runner.ts ios-safari --result /absolute/cross-tab.json",
        required: [crossTabId],
        timeoutMs: crossTabTimeoutMs,
        labels: crossTabLabels,
      },
      null,
      2,
    ),
  );
