const channelName = new URL(self.location.href).searchParams.get("channel");
if (!channelName) throw new Error("Missing test observation channel");
const channel = new BroadcastChannel(channelName);
const openDatabase = indexedDB.open.bind(indexedDB);
indexedDB.open = (name, version) => {
  channel.postMessage({ name });
  return openDatabase(name, version);
};
await import("../../browser/fs-worker.js");

export {};
