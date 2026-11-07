// A relay that acknowledges arming but never forwards a wake. The original
// race body must detect this through its own finite stalled-relay assertion.
globalThis.onmessage = ({ data }: MessageEvent<{ port: MessagePort }>) => {
  data.port.onmessage = () => data.port.postMessage({ type: "armed" });
};
