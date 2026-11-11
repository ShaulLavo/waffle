export function ownershipPeerInput(count: number, fed: number) {
  if (count <= fed) return "wait";
  if (count > 240) return "exceeded";
  if (count === 240) return "exhausted";
  return "feed";
}
