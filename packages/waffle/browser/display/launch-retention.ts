import type { GraphicsGrant } from "./protocol.js";
import type { LaunchedTicket } from "../../memory/reservations.js";
import {
  validGraphicsRetention,
  type GraphicsControlRetention,
} from "../../memory/graphics-retention.js";

const grants = new WeakMap<GraphicsGrant, GraphicsControlRetention>();
const receipts = new Set<{
  worker: Worker;
  ticket: LaunchedTicket;
  retention: GraphicsControlRetention;
}>();

/** Page-only binding, installed before a broker transfers launch authority. */
export function bindGraphicsLaunch(
  grant: GraphicsGrant,
  retention: GraphicsControlRetention,
): void {
  if (!validGraphicsRetention(retention))
    throw new Error("Graphics retention was not issued by a ticket");
  const prior = grants.get(grant);
  if (prior && prior !== retention) throw new Error("Graphics grant already belongs to a launch");
  grants.set(grant, retention);
}
export function graphicsLaunchRetention(grant: GraphicsGrant): GraphicsControlRetention {
  const retention = grants.get(grant);
  if (!retention) throw new Error("Graphics launch is not enrolled");
  return retention;
}
/** Independent of ordinary onmessage teardown and child/root maps, until page destruction. */
export function retainAllocationReceipts(
  worker: Worker,
  ticket: LaunchedTicket,
  retention: GraphicsControlRetention,
  failed: (error: unknown) => void,
): void {
  if (
    Array.from(receipts).some((receipt) => receipt.worker === worker && receipt.ticket === ticket)
  )
    return;
  receipts.add({ worker, ticket, retention });
  worker.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
    if (
      typeof data !== "object" ||
      data === null ||
      !("type" in data) ||
      data.type !== "shared-control-allocation"
    )
      return;
    try {
      if (!("buffer" in data) || !(data.buffer instanceof SharedArrayBuffer))
        throw new TypeError("Invalid control allocation receipt");
      ticket.controlAllocated(data.buffer);
    } catch (error) {
      failed(error);
    }
  });
}
