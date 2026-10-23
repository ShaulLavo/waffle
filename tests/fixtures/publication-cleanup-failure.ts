export const workspaceCleanupPostFailure = "intentional workspace cleanup post failure";

export function failWorkspaceCleanupPost(port: MessagePort): () => number {
  const post = port.postMessage.bind(port);
  let attempted = 0;
  Object.defineProperty(port, "postMessage", {
    value(value: unknown, transfer: Transferable[]) {
      if (value && typeof value === "object" && "stopWorkspace" in value) {
        attempted++;
        throw new Error(workspaceCleanupPostFailure);
      }
      post(value, transfer);
    },
  });
  return () => attempted;
}
