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
let file: OpenDescription | undefined;
let guestClose = false;
const close = DescriptorTable.prototype.close;
DescriptorTable.prototype.close = function (fd) {
  if (!guestClose || fd !== 4 || original) return close.call(this, fd);
  const before = this.get(fd);
  const replacement = this.get(5);
  if (!before || !replacement) return close.call(this, fd);
  original = before.description;
  const result = close.call(this, fd);
  if (original.references !== 1) throw new Error("delayed operation does not own the original pin");
  this.addAt(fd, replacement.description, replacement);
  self.postMessage({ kind: "fd-rebound", references: original.references });
  return result;
};
const get = DescriptorTable.prototype.get;
DescriptorTable.prototype.get = function (fd) {
  const entry = get.call(this, fd);
  if (fd === 4 && entry?.resource.kind === "file") file ??= entry.description;
  return entry;
};
const submit = ThreadService.prototype.submit;
ThreadService.prototype.submit = function (call, request) {
  self.postMessage({ kind: "fd-admitted", call, request });
  guestClose = request.kind === "close";
  let pending: Promise<ThreadResult>;
  try {
    pending = submit.call(this, call, request);
  } finally {
    guestClose = false;
  }
  return pending.then((result) => {
    if (request.kind === "fdstat" && request.fd === 4 && call.thread.tid === 1 && !original) {
      // The experimental guest import reads status. This host sets NONBLOCK between two reads.
      const resource = file?.resource;
      if (resource?.kind === "file") resource.fdflags = 4;
    }
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
