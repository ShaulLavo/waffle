// Yields to the event loop for one macrotask. Browsers clamp nested zero-delay timers to at
// least 4 ms, so a loop that yields with setTimeout(0) spends most of its time asleep; a
// message on a private channel runs as soon as the queue reaches it.
let channel: MessageChannel | undefined;
const waiting: (() => void)[] = [];

export function yieldTask(): Promise<void> {
  return new Promise((resolve) => {
    if (!channel) {
      channel = new MessageChannel();
      channel.port1.onmessage = () => waiting.shift()?.();
      // Node and Bun keep the process alive for a listening port; a yield must not.
      (channel.port1 as { unref?: () => void }).unref?.();
    }
    waiting.push(resolve);
    channel.port2.postMessage(null);
  });
}
