import type { OperationWriter } from "../browser/operations/writer.js";
import { WeakMapConstructor, weakMapDelete, weakMapGet, weakMapSet } from "../proc/intrinsics.js";
import type { FilesystemConnection } from "./protocol.js";

export interface ResolveObservation {
  readonly entered: () => boolean;
  readonly writer: OperationWriter;
}

const observations = new WeakMapConstructor<FilesystemConnection, ResolveObservation>();

export function registerResolveObservation(
  connection: FilesystemConnection,
  observation: ResolveObservation,
): void {
  weakMapSet(observations, connection, observation);
}

export function takeResolveObservation(
  connection: FilesystemConnection,
): ResolveObservation | undefined {
  const observation = weakMapGet(observations, connection);
  if (observation) weakMapDelete(observations, connection);
  return observation;
}
