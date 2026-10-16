import { FilesystemClient, createFilesystemConnection, connectFilesystemIdentity, reapFilesystem, type FilesystemIdentity, type FilesystemConnection } from "@bun-wasm/runtime/fs";

export interface Entry { kind: "file" | "dir"; ino: number; mtime: number; children: Map<string, Entry>; }
/** Page-side API: never blocks the UI thread and owns no tree. Editor/shell saves are ordinary
 * service requests, ordered on this connection; flush establishes completion before starting a run.
 */
export class SharedFilesystem {
  readonly client: FilesystemClient;
  private worker: Worker;
  private writes: Promise<unknown> = Promise.resolve();
  private failure: unknown;
  private fatal: Error | undefined;
  constructor() {
    this.worker = new Worker(new URL("./fs-worker.js", location.href), { type: "module" });
    const connection = createFilesystemConnection();
    this.client = new FilesystemClient(connection.client);
    this.worker.addEventListener("error", event => {
      event.preventDefault();
      this.fail(new Error(`Filesystem worker failed: ${event.message || "uncaught error"}`));
    });
    this.worker.addEventListener("messageerror", () => this.fail(new Error("Filesystem worker message could not be decoded")));
    try { this.worker.postMessage({ connect: connection.server }, [connection.server.port]); }
    catch (error) {
      connection.server.port.close();
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
  private fail(error: Error): void {
    this.fatal ??= error;
    // Revoking the root wakes blocking and asynchronous descendants even when the worker
    // cannot deliver a completion message. No request waits for a dead service to reply.
    this.client.dispose();
    this.worker.terminate();
  }
  private assertLive(): void { if (this.fatal) throw this.fatal; }
  fork(): FilesystemConnection { this.assertLive(); return this.client.fork(); }
  connect(identity: FilesystemIdentity): FilesystemConnection {
    this.assertLive();
    const connection = connectFilesystemIdentity(identity);
    this.client.connection.port.postMessage({ connect: connection.server }, [connection.server.port]);
    return connection.client;
  }
  revoke(connection: FilesystemIdentity): void { reapFilesystem(connection); this.client.sweep(); }
  private mutate(operation: string, args: unknown[], bytes?: Uint8Array): Promise<any> {
    const result = this.writes.then(() => { this.assertLive(); return this.client.asyncCall(operation, args, bytes); });
    // Keep ordering after an error, while returning the failure to the caller that owns it.
    this.writes = result.catch(error => { this.failure ??= error; });
    return result;
  }
  async flush(): Promise<void> { await this.writes; this.assertLive(); if (this.failure !== undefined) { const error = this.failure; this.failure = undefined; throw error; } }
  async lookup(path: string): Promise<Entry | undefined> { await this.flush(); return this.client.asyncCall("lookup", [path]); }
  async readFile(path: string): Promise<Uint8Array | undefined> { await this.flush(); return this.client.asyncCall("readFile", [path]); }
  async listFiles(path = "/"): Promise<string[]> { await this.flush(); return this.client.asyncCall("listFiles", [path]); }
  mkdirp(path: string): Promise<void> { return this.mutate("mkdirp", [path]); }
  writeFile(path: string, text: string | Uint8Array, append = false): Promise<void> { return this.mutate("writeFile", [path, append], typeof text === "string" ? new TextEncoder().encode(text) : text); }
  remove(path: string): Promise<boolean> { return this.mutate("remove", [path]); }
  async move(from: string, to: string): Promise<void> {
    const error = await this.mutate("move", [from, to]);
    if (error) throw new Error(`rename failed: errno ${error}`);
  }
  dispose(): void { this.client.dispose(); this.worker.terminate(); }
}
