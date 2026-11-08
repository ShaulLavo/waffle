export async function runNetworkRelayBrowser(
  names: readonly string[] = ["chromium"],
): Promise<void> {
  const startedAt = performance.now();
  const { completeNetworkCommand, networkTargets } = await import("./network-command.js");
  const exit = await completeNetworkCommand(networkTargets(names), { startedAt }, true);
  if (exit !== 0) throw new Error(`Network relay browser matrix failed with exit ${exit}`);
}
if (import.meta.main)
  await runNetworkRelayBrowser(process.argv.length > 2 ? process.argv.slice(2) : undefined);
