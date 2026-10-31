import { FilesystemError } from "../core/filesystem.js";
import type { FilesystemIdentity } from "./protocol.js";
import {
  Int32ArrayConstructor,
  atomicsLoad,
  atomicsAdd,
  atomicsNotify,
} from "../proc/intrinsics/core.js";

export function isRevoked(connection: FilesystemIdentity): boolean {
  if (
    connection.publication &&
    atomicsLoad(new Int32ArrayConstructor(connection.publication.buffers.control), 0)
  )
    return true;
  if (atomicsLoad(new Int32ArrayConstructor(connection.ownerStates), 0)) return true;
  for (let index = 0; index < connection.revocations.length; index++)
    if (atomicsLoad(new Int32ArrayConstructor(connection.revocations[index]!), 0)) return true;
  return false;
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
    this.cells = new Int32ArrayConstructor(connection.sections);
  }
  enter(): void {
    atomicsAdd(this.cells, 0, 1);
    if (!this.revoked()) return;
    this.exit();
    throw new FilesystemError(11);
  }
  exit(): void {
    if (atomicsAdd(this.cells, 0, -1) === 1) atomicsNotify(this.cells, 0);
  }
}
