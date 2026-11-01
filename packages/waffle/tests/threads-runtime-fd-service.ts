import { DescriptorTable, type OpenDescription } from "../core/descriptors.ts";
import { ThreadService } from "../thread/service.ts";
import { threadServiceCommand } from "../thread/service-worker.ts";
import type { ThreadServiceCommand } from "../thread/runtime-protocol.ts";

import type { CallKey, ThreadOperation, ThreadResult } from "../thread/protocol.ts";

export type FdServiceEvent =
  | { kind: "fd-admitted"; call: CallKey; request: ThreadOperation }
  | {
      kind: "fd-completed";
      call: CallKey;
      request: ThreadOperation;
      result: ThreadResult;
      original: { references: number; offset: number | undefined } | undefined;
    }
  | { kind: "fd-rebound"; references: number };

let original: OpenDescription | undefined;
const close = DescriptorTable.prototype.close;
DescriptorTable.prototype.close = function (fd) {
  const before = this.get(fd);
  const replacement = this.get(5);
  if (fd !== 4 || !before || !replacement || original) return close.call(this, fd);
  original = before.description;
  const result = close.call(this, fd);
  if (original.references !== 1) throw new Error("delayed operation does not own the original pin");
  this.addAt(fd, replacement.description, replacement);
  self.postMessage({ kind: "fd-rebound", references: original.references });
  return result;
};
const submit = ThreadService.prototype.submit;
ThreadService.prototype.submit = function (call, request) {
  self.postMessage({ kind: "fd-admitted", call, request });
  return submit.call(this, call, request).then((result) => {
    const pin = original?.resource;
    self.postMessage({
      kind: "fd-completed",
      call,
      request,
      result,
      original: original && {
        references: original.references,
        offset: pin?.kind === "file" ? pin.offset : undefined,
      },
    });
    return result;
  });
};
self.onmessage = ({ data }: MessageEvent<ThreadServiceCommand>) => {
  void threadServiceCommand(data).catch((error: unknown) =>
    self.postMessage({ kind: "service-error", message: String(error) }),
  );
};
