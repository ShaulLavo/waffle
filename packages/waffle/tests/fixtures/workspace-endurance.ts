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

function counter(resources: Readonly<Record<string, unknown>>, name: string): number {
  const value = resources[name];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`workspace ownership counter missing or invalid: ${name}`);
  return value;
}

export function workspaceOwnership(value: WorkspaceEnduranceValue): WorkspaceOwnership {
  const resources = value.service.resources();
  return {
    clients: counter(resources, "clients"),
    readerLeases: counter(resources, "readerLeases"),
    readerMetadataBytes: counter(resources, "readerMetadataBytes"),
    readerOperations: counter(resources, "readerOperations"),
    readerPinBytes: counter(resources, "readerPinBytes"),
    readerResultBytes: counter(resources, "readerResultBytes"),
    readerSeedBytes: counter(resources, "readerSeedBytes"),
    readerTickets: counter(resources, "readerTickets"),
    registeredHandles: value.backend.shared.registeredHandles().length,
    responses: counter(resources, "responses"),
    retained: counter(resources, "retained"),
    sharedUsedBytes: counter(value.backend.shared.resources(), "usedBytes"),
    transient: counter(resources, "transient"),
    workspaceCursors: counter(resources, "workspaceCursors"),
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

function workspaceSeed(size: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    { length: size },
    (_, index) => ((index * 73) ^ (index >>> 8) ^ (index >>> 16)) & 255,
  );
}

async function seedWorkspace(value: WorkspaceEnduranceValue, bytes: Uint8Array): Promise<void> {
  for (let offset = 0; offset < bytes.length; offset += PAGE) {
    const part = bytes.subarray(offset, offset + PAGE);
    const written = await value.client.asyncCall("write", [value.handle, offset], part);
    if (written !== part.length) throw new Error("workspace setup write was incomplete");
  }
}

export async function workspaceEnduranceFixture(
  size = PAGE * 3 + 17,
  create: typeof residentReadFixture = residentReadFixture,
) {
  const value = await create(size);
  try {
    const bytes = workspaceSeed(size);
    await seedWorkspace(value, bytes);
    const initialized = await value.workspace.read("/file", { offset: 0, length: 0 });
    if (initialized.kind !== "ok")
      throw new Error(`workspace setup read failed: ${initialized.kind}`);
    const baseline = workspaceOwnership(value);
    return { ...value, baseline, bytes };
  } catch (error) {
    try {
      await value.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "workspace setup and cleanup failed");
    }
    throw error;
  }
}
