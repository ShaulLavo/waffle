export type FileId = bigint & { readonly __brand: "FileId" };
export type FileVersion = bigint & { readonly __brand: "FileVersion" };
export interface FileIdentity {
  readonly id: FileId;
  readonly version: FileVersion;
}
export interface IdentityReservation {
  readonly workspace: string;
  readonly era: bigint;
}
