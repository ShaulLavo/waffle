import type { ProcessFilesystem } from "../../browser/process-broker.js";
import type { FilesystemService } from "../../fs/service.js";
import { FilesystemRequestPool } from "../../fs/request-memory.js";
import {
  connectFilesystemIdentity,
  revokeFilesystem,
  reapFilesystem,
  waitForFilesystemQuiescence,
} from "../../fs/protocol.js";
import type { RuntimeReservations } from "../../memory/reservations.js";

export function processFilesystem(
  service: FilesystemService,
  reservations: RuntimeReservations,
  ports: MessagePort[],
): ProcessFilesystem {
  const pools = new WeakMap<SharedArrayBuffer, FilesystemRequestPool>();
  return {
    connect(identity, headroom) {
      let pool = pools.get(identity.requestBudget);
      if (!pool) {
        pool = new FilesystemRequestPool(identity.requestBudget, undefined, reservations.arenas);
        pools.set(identity.requestBudget, pool);
      }
      const pair = connectFilesystemIdentity(identity, pool, undefined, headroom);
      ports.push(pair.client.port, pair.server.port);
      service.connect(pair.server);
      return pair.client;
    },
    revoke: revokeFilesystem,
    reap: reapFilesystem,
    quiesce: waitForFilesystemQuiescence,
  };
}
