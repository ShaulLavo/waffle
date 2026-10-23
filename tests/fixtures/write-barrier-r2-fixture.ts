import type { FilesystemClient } from "../../fs/client";

export async function retainedFile(client: FilesystemClient): Promise<number> {
  await client.asyncCall("writeFile", ["/shared"], new TextEncoder().encode("before"));
  const root: number = await client.asyncCall("preopen", ["/"]);
  const path: { node: number } = await client.asyncCall("resolve", [root, "shared"]);
  client.retain(path.node);
  return path.node;
}
