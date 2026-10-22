import "./publication-resident-authority";
import { FilesystemClient } from "../../fs/client";
import { publicationObserver } from "../../fs/publication-internal";
import { integer, record } from "../../fs/publication-attachment";
import { publicationCut } from "../../fs/publication";

let observed: ReturnType<typeof publicationObserver> | undefined;
const nativeCall = FilesystemClient.prototype.asyncCall;
FilesystemClient.prototype.asyncCall = function (...args: Parameters<typeof nativeCall>) {
  if (args[0] === "publicationWorkspace" && this.connection.publication?.observer)
    observed = publicationObserver(this);
  return nativeCall.apply(this, args);
};

// Observation stays inside the authority worker. No root connection or SAB leaves it.
Object.defineProperty(globalThis, "__persistentAuthorityProof", {
  async value(operation: string, body: unknown): Promise<unknown> {
    const observer = observed;
    if (!observer) throw new Error("actual factory root was not observed");
    if (operation === "cut") return observer.cut();
    if (operation === "changes") return observer.changes(publicationCut(body), 32768);
    if (operation === "diagnostics") return observer.diagnostics();
    if (operation !== "receipt") throw new Error(`unknown observation ${operation}`);
    const id = record(body);
    return observer.receipt({ session: integer(id.session), sequence: integer(id.sequence) });
  },
});
