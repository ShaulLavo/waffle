import { isInstance, isSharedArrayBuffer } from "./intrinsics.ts";
import { OpenDescription, type Descriptor, type Resource } from "../core/descriptors.js";
import {
  readSharedOfdBuffer,
  retainSharedOfdTransfer,
  shareDirectoryOfd,
  shareFileResource,
} from "../core/open-file.js";
import { FilesystemClient } from "../fs/client.js";
import {
  releaseFilesystemReservation,
  type FilesystemIdentity,
  type FilesystemReservation,
} from "../fs/protocol.js";
import type { WorkerDescriptorCodec } from "./worker-client.js";

export interface FilesystemDescriptorToken {
  kind: "filesystem";
  resource: "file" | "directory";
  reservation: FilesystemReservation;
  offset?: SharedArrayBuffer;
  ofd?: SharedArrayBuffer;
}
export function isFilesystemDescriptorToken(token: unknown): token is FilesystemDescriptorToken {
  return (
    typeof token === "object" && token !== null && "kind" in token && token.kind === "filesystem"
  );
}

function tokenOfdBuffer(token: FilesystemDescriptorToken): SharedArrayBuffer | undefined {
  const candidate = token.resource === "file" ? token.offset : token.ofd;
  return isSharedArrayBuffer(candidate) ? candidate : undefined;
}

function releaseTokenOfd(client: FilesystemClient, token: FilesystemDescriptorToken): void {
  const buffer = tokenOfdBuffer(token);
  if (!buffer) return;
  const ofd = readSharedOfdBuffer(buffer);
  if (!ofd?.locked) return;
  try {
    client.locks.releaseOfd(token.reservation.handle, ofd.id);
  } catch {}
}

/** Controller imports need only the identity and a live controller sweep notifier; guests pass
 * their actual client. Both import the same reference, whose release is shared and idempotent.
 * An undefined identity supplies discard-only cleanup, independent of admission metadata. */
export function createFilesystemDescriptorCodec(
  filesystem: FilesystemClient | FilesystemIdentity | undefined,
  target?: FilesystemIdentity,
  sweep?: () => void,
): WorkerDescriptorCodec {
  const client = isInstance(filesystem, FilesystemClient) ? filesystem : undefined;
  const identity = client?.connection ?? (filesystem as FilesystemIdentity | undefined);
  const discard = (token: unknown) => {
    if (!isFilesystemDescriptorToken(token))
      throw new TypeError("not a filesystem descriptor token");
    const won = releaseFilesystemReservation(token.reservation);
    const localOwner = client && token.reservation.targetOwner === client.connection.owner;
    if (won && localOwner) releaseTokenOfd(client, token);
    if (localOwner) client.finishReleasedReservation(token.reservation, won);
    else if (won) (sweep ?? (() => client?.sweep()))();
  };
  return {
    export(descriptor: Descriptor): FilesystemDescriptorToken {
      const resource = descriptor.resource;
      if (resource.kind !== "file" && resource.kind !== "directory")
        throw new TypeError("not a filesystem descriptor");
      if (!client || !target)
        throw new TypeError("filesystem export requires a client and child identity");
      // Promote before reserving: a failed offset conversion cannot strand a child pin.
      const offset =
        resource.kind === "file" ? shareFileResource(resource, client.connection) : undefined;
      const dirOfd =
        resource.kind === "directory" ? shareDirectoryOfd(resource, client.connection) : undefined;
      const reservation = client.reserve(resource.handle, target);
      const ofd = offset ?? dirOfd;
      if (ofd) {
        reservation.ofd = ofd;
        retainSharedOfdTransfer(ofd);
      }
      return {
        kind: "filesystem",
        resource: resource.kind,
        reservation,
        offset,
        ...(dirOfd ? { ofd: dirOfd } : {}),
      };
    },
    import(token: unknown): OpenDescription {
      if (!isFilesystemDescriptorToken(token))
        throw new TypeError("not a filesystem descriptor token");
      if (!identity) throw new TypeError("filesystem import requires a process identity");
      if (token.reservation.targetOwner !== identity.owner)
        throw new TypeError("filesystem descriptor belongs to another process");
      const handle = token.reservation.handle;
      let resource: Resource;
      if (token.resource === "file") {
        if (!isSharedArrayBuffer(token.offset)) throw new TypeError("file offset is missing");
        resource = { kind: "file", handle, offset: 0, append: false };
        shareFileResource(resource, identity, token.offset);
      } else {
        resource = { kind: "directory", handle };
        if (isSharedArrayBuffer(token.ofd)) shareDirectoryOfd(resource, identity, token.ofd);
      }
      client?.adopt(token.reservation);
      return new OpenDescription(resource, () => discard(token));
    },
    discard,
  };
}
