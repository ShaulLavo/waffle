import { FilesystemClient, type FilesystemConnection } from "../../fs/index.js";
import { preview1, rootedSymlinkScenario } from "./rooted-symlinks-guest.js";

/** The rooted symlink scenario over the worker-backed client, as a process worker runs it. */
self.onmessage = ({ data }: MessageEvent<FilesystemConnection>) => {
  const client = new FilesystemClient(data);
  try {
    const scenario = rootedSymlinkScenario(client);
    // The same path through the client's path cache, rooted and then confined.
    const rooted = preview1(client).stat("tmp/x/climb", true);
    const confined = preview1(client, { "/tmp": "/tmp" }).stat("x/climb", true);
    self.postMessage({ scenario, cache: [rooted, confined] });
  } catch (error) {
    self.postMessage({ error: String(error) });
  } finally {
    client.dispose();
  }
};
