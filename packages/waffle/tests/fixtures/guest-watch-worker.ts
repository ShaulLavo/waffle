import { FilesystemClient } from "../../fs/client.js";
import type { FilesystemConnection } from "../../fs/protocol.js";
import { Wasi } from "../../core/wasi.js";
import { watchGuest, watchGuestModule } from "./watch-guest.js";

self.onmessage = ({
  data,
}: MessageEvent<{ connection: FilesystemConnection; control: SharedArrayBuffer }>) => {
  const fs = new FilesystemClient(data.connection);
  const control = new Int32Array(data.control);
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: { "/": "/" },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  const module = watchGuestModule();
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  wasi.start(instance);
  const guest = watchGuest(instance);
  const opened = guest.open(3, 1);
  self.postMessage({ opened, ready: guest.ready(), pending: wasi.filesystemWatches?.pending() });
  Atomics.wait(control, 0, 0);
  const ready = guest.ready();
  self.postMessage({
    ready,
    drained: guest.drain(opened.id),
    afterDrain: guest.ready(),
    pending: wasi.filesystemWatches?.pending(),
  });
  Atomics.wait(control, 1, 0);
  self.postMessage({
    revoked: [guest.ready(), guest.ready(), guest.read(opened.id).errno, guest.ready()],
    pending: wasi.filesystemWatches?.pending(),
  });
  // Parked with a live subscription: only the owner's forced cleanup may release it.
  Atomics.wait(control, 1, 1);
};
