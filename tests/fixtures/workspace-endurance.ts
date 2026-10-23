import { PAGE } from "../../fs/protocol";
import { residentReadFixture } from "./workspace-read";

export type WorkspaceEnduranceValue = Awaited<ReturnType<typeof residentReadFixture>>;

export interface WorkspaceOwnership {
  readonly clients: number;
  readonly readerLeases: number;
  readonly readerMetadataBytes: number;
  readonly readerOperations: number;
  readonly readerPinBytes: number;
  readonly readerResultBytes: number;
  readonly readerSeedBytes: number;
  readonly readerTickets: number;
  readonly registeredHandles: number;
  readonly responses: number;
  readonly retained: number;
  readonly sharedUsedBytes: number;
  readonly transient: number;
  readonly workspaceCursors: number;
}

const ownershipKeys: readonly (keyof WorkspaceOwnership)[] = [
  "clients",
  "readerLeases",
  "readerMetadataBytes",
  "readerOperations",
  "readerPinBytes",
  "readerResultBytes",
  "readerSeedBytes",
  "readerTickets",
  "registeredHandles",
  "responses",
  "retained",
  "sharedUsedBytes",
  "transient",
  "workspaceCursors",
];

export function workspaceOwnership(value: WorkspaceEnduranceValue): WorkspaceOwnership {
  const resources = value.service.resources();
  return {
    clients: resources.clients,
    readerLeases: resources.readerLeases ?? 0,
    readerMetadataBytes: resources.readerMetadataBytes ?? 0,
    readerOperations: resources.readerOperations ?? 0,
    readerPinBytes: resources.readerPinBytes ?? 0,
    readerResultBytes: resources.readerResultBytes ?? 0,
    readerSeedBytes: resources.readerSeedBytes ?? 0,
    readerTickets: resources.readerTickets ?? 0,
    registeredHandles: value.backend.shared.registeredHandles().length,
    responses: resources.responses ?? 0,
    retained: resources.retained ?? 0,
    sharedUsedBytes: value.backend.shared.resources().usedBytes,
    transient: resources.transient ?? 0,
    workspaceCursors: resources.workspaceCursors ?? 0,
  };
}

export function assertWorkspaceQuiescent(
  value: WorkspaceEnduranceValue,
  baseline: WorkspaceOwnership,
): void {
  const actual = workspaceOwnership(value);
  for (const key of ownershipKeys)
    if (actual[key] !== baseline[key])
      throw new Error(`workspace ownership changed for ${key}: ${baseline[key]} -> ${actual[key]}`);
}

export async function workspaceEnduranceFixture(size = PAGE * 3 + 17) {
  const value = await residentReadFixture(size);
  const initialized = await value.workspace.read("/file", { offset: 0, length: 0 });
  if (initialized.kind !== "ok")
    throw new Error(`workspace setup read failed: ${initialized.kind}`);
  const baseline = workspaceOwnership(value);
  return { ...value, baseline };
}
