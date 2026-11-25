import { FilesystemClient, type FilesystemConnection } from "../../fs/index.js";
import { fdReopenCases } from "./fd-reopen-cases.js";

const cases = fdReopenCases();

self.onmessage = ({ data }: MessageEvent<{ connection: FilesystemConnection; index: number }>) => {
  const fs = new FilesystemClient(data.connection);
  try {
    const entry = cases[data.index];
    if (!entry) throw new Error(`unknown fdReopenCase index ${data.index}`);
    entry.run(() => fs);
    self.postMessage({ ok: true });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  } finally {
    fs.dispose();
  }
};
