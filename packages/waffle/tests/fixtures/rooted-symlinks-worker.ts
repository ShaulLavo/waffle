import { FilesystemClient, type FilesystemConnection } from "../../fs/index.js";
import { preview1, rootedSymlinkScenario } from "./rooted-symlinks-guest.js";

/** The rooted symlink scenario over the worker-backed client, as a process worker runs it. */
self.onmessage = ({ data }: MessageEvent<FilesystemConnection>) => {
  const client = new FilesystemClient(data);
  let reply: unknown;
  try {
    const scenario = rootedSymlinkScenario(client);
    // The same directory handle, path and follow flag in a rooted and a confined process, both
    // made before either warms the client's path cache, each asked twice.
    const rooted = preview1(client);
    const confined = preview1(client, { "/tmp": "/tmp" });
    try {
      const tmp = rooted.openDirectory("tmp");
      const same = rooted.handleOf(tmp) === confined.handleOf(3);
      const ask = () => [rooted.stat("x/climb", true, tmp), confined.stat("x/climb", true)];
      reply = { scenario, same, cache: ask().concat(ask()) };
    } finally {
      rooted.dispose();
      confined.dispose();
    }
  } catch (error) {
    reply = { error: String(error) };
  } finally {
    client.dispose();
  }
  self.postMessage(reply);
};
