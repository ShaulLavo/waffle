export {};
self.postMessage("ready");
await Bun.sleep(0);
throw new Error("watch worker delivery failure");
