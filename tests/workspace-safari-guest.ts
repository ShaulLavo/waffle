import { FilesystemClient, createWorkspaceVfs, type FilesystemConnection } from "waffle/fs";

export type WorkspaceSafariGuestRequest =
  | { connection: FilesystemConnection }
  | { operation: "namespace" };
let client: FilesystemClient | undefined;
async function namespace(): Promise<void> {
  if (!client) throw new Error("Guest is not connected");
  await client.asyncCall("writeFile", ["/guest"], new TextEncoder().encode("guest"));
  self.postMessage({ hint: "created" });
  await client.asyncCall("move", ["/guest", "/guest-renamed"]);
  self.postMessage({ hint: "renamed" });
  await client.asyncCall("remove", ["/guest-renamed"]);
  self.postMessage({ hint: "removed" });
  self.postMessage({ complete: true });
}
async function receive(data: WorkspaceSafariGuestRequest) {
  if ("connection" in data) {
    client = new FilesystemClient(data.connection);
    let denied = false;
    try {
      createWorkspaceVfs(client);
    } catch {
      denied = true;
    }
    if (!denied) throw new Error("Worker guest inherited observer access");
    self.postMessage({ ready: true, observerDenied: true });
    return;
  }
  await namespace();
}
self.onmessage = ({ data }: MessageEvent<WorkspaceSafariGuestRequest>) => {
  void receive(data).catch((error: unknown) => self.postMessage({ failure: String(error) }));
};
