const instance = crypto.randomUUID();
let connections = 0;
let value = "";
Reflect.set(globalThis, "onconnect", (event: MessageEvent) => {
  const port = event.ports[0];
  if (!port) return;
  connections++;
  port.onmessage = (message: MessageEvent<{ id: number; value?: string }>) => {
    if (message.data.value !== undefined) value = message.data.value;
    port.postMessage({ id: message.data.id, instance, connections, value });
  };
  port.start();
});

export {};
