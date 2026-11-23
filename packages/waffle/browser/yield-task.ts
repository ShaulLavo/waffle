// Yields to the event loop for one macrotask. Browsers clamp nested zero-delay timers to at
// least 4 ms, so a loop that yields with setTimeout(0) spends most of its time asleep; a
// message on a private channel runs as soon as the queue reaches it.
type NodePort = MessagePort & { ref?: () => void; unref?: () => void };
let port: NodePort | undefined;
let sender: MessagePort | undefined;
const waiting: (() => void)[] = [];

export function yieldTask(): Promise<void> {
  return new Promise((resolve) => {
    if (!port) {
      const channel = new MessageChannel();
      port = channel.port1 as NodePort;
      sender = channel.port2;
      port.onmessage = () => {
        waiting.shift()?.();
        // Node and Bun keep the process alive while a port listens: only while a yield waits.
        if (!waiting.length) port!.unref?.();
      };
    }
    if (!waiting.length) port.ref?.();
    waiting.push(resolve);
    sender!.postMessage(null);
  });
}
