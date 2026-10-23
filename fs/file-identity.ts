import { FilesystemError } from "../core/filesystem.js";
import {
  BigIntConstructor,
  bigintToString,
  Int32ArrayConstructor,
  typedArrayLength,
  typedArraySet,
} from "../proc/intrinsics.js";

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
export interface StoredIdentity {
  readonly format: "waffle-file-identity-v1";
  readonly workspace: string;
  readonly id: string;
  readonly version: string;
}
export interface StoredReservation {
  readonly format: "waffle-identity-reservation-v1";
  readonly workspace: string;
  readonly era: string;
}
export const MAX_IDENTITY_PART = (1n << 64n) - 1n;
const MAX_TOKEN = (1n << 128n) - 1n;
const workspacePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function invalid(): never {
  throw new Error("Invalid filesystem identity metadata");
}
function token(value: unknown, max: bigint): bigint {
  if (typeof value !== "string" || !/^[1-9a-f][0-9a-f]{0,31}$/.test(value)) invalid();
  const parsed = BigIntConstructor(`0x${value}`);
  if (parsed > max) invalid();
  return parsed;
}
function workspace(value: unknown): string {
  if (typeof value !== "string" || !workspacePattern.test(value)) invalid();
  return value;
}
function fileToken(value: unknown): bigint {
  const parsed = token(value, MAX_TOKEN);
  if (parsed >> 64n === 0n || (parsed & MAX_IDENTITY_PART) === 0n) invalid();
  return parsed;
}
export function parseFileIdentity(value: unknown): FileIdentity {
  if (typeof value !== "object" || value === null || !("id" in value) || !("version" in value))
    invalid();
  const id = fileToken(value.id),
    version = fileToken(value.version);
  if (version < id) invalid();
  return { id: id as FileId, version: version as FileVersion };
}
export function parseStoredIdentity(value: unknown): StoredIdentity {
  if (
    typeof value !== "object" ||
    value === null ||
    !("format" in value) ||
    value.format !== "waffle-file-identity-v1"
  )
    invalid();
  if (!("workspace" in value) || !("id" in value) || !("version" in value)) invalid();
  workspace(value.workspace);
  parseFileIdentity(value);
  return {
    format: value.format,
    workspace: workspace(value.workspace),
    id: String(value.id),
    version: String(value.version),
  };
}
export function restoreIdentity(value: StoredIdentity): FileIdentity {
  return parseFileIdentity(value);
}
export function storeIdentity(value: FileIdentity, workspace: string): StoredIdentity {
  return {
    format: "waffle-file-identity-v1",
    workspace,
    id: bigintToString(value.id, 16),
    version: bigintToString(value.version, 16),
  };
}
export function nextReservation(value: unknown, expected?: string): IdentityReservation {
  if (value === undefined) {
    if (expected !== undefined) invalid();
    return { workspace: crypto.randomUUID(), era: 1n };
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("format" in value) ||
    value.format !== "waffle-identity-reservation-v1"
  )
    invalid();
  if (!("workspace" in value) || !("era" in value)) invalid();
  const name = workspace(value.workspace);
  if (expected !== undefined && name !== expected) invalid();
  const era = token(value.era, MAX_IDENTITY_PART);
  if (era === MAX_IDENTITY_PART) throw new FilesystemError(33, "filesystem identity era exhausted");
  return { workspace: name, era: era + 1n };
}
export function storeReservation(value: IdentityReservation): StoredReservation {
  return {
    format: "waffle-identity-reservation-v1",
    workspace: value.workspace,
    era: bigintToString(value.era, 16),
  };
}
export function readIdentityWords(words: Int32Array, at: number): bigint {
  let value = 0n;
  for (let index = 3; index >= 0; index--)
    value = (value << 32n) | BigIntConstructor(words[at + index]! >>> 0);
  return value;
}
export function writeIdentityWords(words: Int32Array, at: number, value: bigint): void {
  for (let index = 0; index < 4; index++) {
    words[at + index] = Number(value & 0xffffffffn);
    value >>= 32n;
  }
}
export class IdentityAllocator {
  constructor(private readonly words: Int32Array) {}
  get active(): boolean {
    return this.words[0] === 1;
  }
  get available(): bigint {
    return MAX_IDENTITY_PART - readIdentityWords(this.words, 5);
  }
  configure(reservation: IdentityReservation, serial = 0n): void {
    if (
      reservation.era < 1n ||
      reservation.era > MAX_IDENTITY_PART ||
      serial < 0n ||
      serial > MAX_IDENTITY_PART
    )
      invalid();
    writeIdentityWords(this.words, 1, reservation.era);
    writeIdentityWords(this.words, 5, serial);
    this.words[0] = 1;
  }
  stage(): IdentityAllocator {
    const staged = new IdentityAllocator(new Int32ArrayConstructor(typedArrayLength(this.words)));
    staged.copyFrom(this);
    return staged;
  }
  copyFrom(source: IdentityAllocator): void {
    typedArraySet(this.words, source.words);
  }
  reserve(count: number): bigint[] {
    if (!Number.isSafeInteger(count) || count < 0) invalid();
    if (!this.active || BigIntConstructor(count) > this.available)
      throw new FilesystemError(33, "filesystem identity serial exhausted");
    const era = readIdentityWords(this.words, 1);
    const serial = readIdentityWords(this.words, 5);
    const values = Array.from(
      { length: count },
      (_, index) => (era << 64n) | (serial + BigIntConstructor(index) + 1n),
    );
    writeIdentityWords(this.words, 5, serial + BigIntConstructor(count));
    return values;
  }
  create(): FileIdentity {
    const value = this.reserve(1)[0]!;
    return { id: value as FileId, version: value as FileVersion };
  }
  versions(count: number): FileVersion[] {
    return this.reserve(count).map((value) => value as FileVersion);
  }
}
