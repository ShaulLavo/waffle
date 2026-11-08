import type { GpuServiceRequest, GpuServiceReply } from "../../../browser/display/service-protocol.js";

interface DisposalOwner {
  readonly open: { readonly grant: number };
  readonly retiredAck: boolean;
}
export function disposalRetirementReady(
  message: GpuServiceRequest | GpuServiceReply,
  owners: readonly DisposalOwner[],
  selectedGrant: number | undefined,
): boolean {
  if (message.type !== "retired" || selectedGrant === undefined) return false;
  return (
    owners.some((owner) => owner.open.grant === message.grant) &&
    owners.some((owner) => owner.open.grant === selectedGrant) &&
    owners.every((owner) => owner.retiredAck)
  );
}
