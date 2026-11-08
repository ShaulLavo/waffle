export async function runNetworkBrowser(names: readonly string[] = ["chromium"]): Promise<void> {
  const startedAt = performance.now();
  const { completeNetworkCommand, networkTargets } = await import("./network-command.js");
  const exit = await completeNetworkCommand(networkTargets(names), { startedAt });
  if (exit !== 0) throw new Error(`Complete network command failed with exit ${exit}`);
}
if (import.meta.main) {
  const startedAt = performance.now();
  const { nativeNetworkCommand, completeNetworkCommand, networkTargets } =
    await import("./network-command.js");
  if (process.argv[2] === "--page-controls") {
    const { networkCommandControls } = await import("./network-command-controls.js");
    await networkCommandControls();
  } else if (process.argv[2] === "ios-safari")
    process.exitCode = await nativeNetworkCommand(process.argv.slice(3), startedAt);
  else
    process.exitCode = await completeNetworkCommand(
      networkTargets(process.argv.length > 2 ? process.argv.slice(2) : ["chromium"]),
      { startedAt },
    );
}
