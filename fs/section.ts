import { FilesystemError } from "../core/filesystem.js";
import type { FilesystemIdentity } from "./protocol.js";

export function isRevoked(connection: FilesystemIdentity): boolean {
  if (
    connection.publication &&
    Atomics.load(new Int32Array(connection.publication.buffers.control), 0)
  )
    return true;
  if (Atomics.load(new Int32Array(connection.ownerStates), 0)) return true;
  return connection.revocations.some((buffer) => Atomics.load(new Int32Array(buffer), 0) !== 0);
}
/** Admission must precede every client lock, pin change or page write. The shared count handles
 * nested synchronous operations and multiple users of one identity. Never hold a section across
 * an await or a call into guest Wasm. Revocation is checked AFTER admission: the supervisor's
 * revoke-then-zero observation proves that any later entrant will abort before touching storage. */
export class FilesystemSection {
  private readonly cells: Int32Array;
  constructor(
    connection: FilesystemIdentity,
    private readonly revoked: () => boolean = () => isRevoked(connection),
  ) {
    this.cells = new Int32Array(connection.sections);
  }
  enter(): void {
    Atomics.add(this.cells, 0, 1);
    if (!this.revoked()) return;
    this.exit();
    throw new FilesystemError(11);
  }
  exit(): void {
    if (Atomics.sub(this.cells, 0, 1) === 1) Atomics.notify(this.cells, 0);
  }
}
