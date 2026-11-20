import { FilesystemClient, type FilesystemConnection } from "../../fs/index.js";
import { fileTimeScenarios, type FileTimeScenario } from "./file-times-guest.js";

/** A guest Worker: synchronous WASI calls wait on the service in the parent thread. */
self.onmessage = ({
  data,
}: MessageEvent<{ connection: FilesystemConnection; scenario: FileTimeScenario }>) => {
  const fs = new FilesystemClient(data.connection);
  try {
    self.postMessage({ value: fileTimeScenarios[data.scenario](fs) });
  } catch (error) {
    self.postMessage({ error: String(error) });
  } finally {
    fs.dispose();
  }
};
