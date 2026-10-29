import { invalid } from "./metadata.js";

/**
 * Scan-only instruction decoder for memory group admission. A member image must not grow the
 * shared memory itself: group growth is charged by the owner through runtime_shm.group_grow.
 * Unknown opcodes are rejected rather than skipped, so a new proposal cannot hide a grow.
 */
class Cursor {
  at = 0;
  constructor(
    readonly bytes: Uint8Array,
    readonly member: string,
  ) {}
  byte(): number {
    const value = this.bytes[this.at++];
    if (value === undefined) invalid(this.member, "truncated code section");
    return value;
  }
  leb(): number {
    let result = 0;
    for (let shift = 0; ; shift += 7) {
      const value = this.byte();
      if (shift < 32) result += (value & 0x7f) * 2 ** shift;
      if (value < 0x80) return result;
      if (shift > 63) invalid(this.member, "invalid LEB128 in code section");
    }
  }
  skip(count: number): void {
    if (this.at + count > this.bytes.length) invalid(this.member, "truncated code section");
    this.at += count;
  }
}

const SINGLE_BYTE_BLOCK_TYPES = new Set([0x40, 0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f]);
const NO_IMMEDIATE = new Set([0x00, 0x01, 0x05, 0x0a, 0x0b, 0x0f, 0x19, 0x1a, 0x1b, 0xd1, 0xd3]);
const ONE_INDEX = new Set([
  0x07, 0x08, 0x09, 0x0c, 0x0d, 0x10, 0x12, 0x14, 0x15, 0x18, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25,
  0x26, 0xd2, 0xd4, 0xd6,
]);

function blockType(cursor: Cursor): void {
  if (SINGLE_BYTE_BLOCK_TYPES.has(cursor.bytes[cursor.at]!)) cursor.skip(1);
  else cursor.leb();
}
function memarg(cursor: Cursor): void {
  const flags = cursor.leb();
  if (flags & 0x40) cursor.leb();
  cursor.leb();
}
function valueType(cursor: Cursor): void {
  const type = cursor.byte();
  if (type === 0x63 || type === 0x64) cursor.leb();
}

// 0xfc sub-opcode -> number of LEB immediates (memory.init carries data + memory index).
const BULK_IMMEDIATES = [0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 2, 1, 2, 1, 2, 1, 1, 1];

function bulk(cursor: Cursor): void {
  const sub = cursor.leb();
  const count = BULK_IMMEDIATES[sub];
  if (count === undefined) invalid(cursor.member, `unsupported opcode 0xfc:${sub}`);
  for (let index = 0; index < count; index++) cursor.leb();
}
function simd(cursor: Cursor): void {
  const sub = cursor.leb();
  if (sub <= 11 || sub === 92 || sub === 93) memarg(cursor);
  else if (sub === 12 || sub === 13) cursor.skip(16);
  else if (sub >= 21 && sub <= 34) cursor.skip(1);
  else if (sub >= 84 && sub <= 91) {
    memarg(cursor);
    cursor.skip(1);
  } else if (sub > 0x113) invalid(cursor.member, `unsupported opcode 0xfd:${sub}`);
}
function atomic(cursor: Cursor): void {
  const sub = cursor.leb();
  if (sub === 3) cursor.skip(1);
  else if (sub <= 2 || (sub >= 0x10 && sub <= 0x4e)) memarg(cursor);
  else invalid(cursor.member, `unsupported opcode 0xfe:${sub}`);
}

/** Returns false at the first memory.grow; throws on an undecodable instruction. */
function instruction(cursor: Cursor): boolean {
  const opcode = cursor.byte();
  if (opcode === 0x40) return false;
  if (NO_IMMEDIATE.has(opcode) || (opcode >= 0x45 && opcode <= 0xc4)) return true;
  if (ONE_INDEX.has(opcode)) cursor.leb();
  else if (opcode >= 0x02 && opcode <= 0x06) blockType(cursor);
  else if (opcode >= 0x28 && opcode <= 0x3e) memarg(cursor);
  else if (opcode === 0x3f || opcode === 0x11 || opcode === 0x13) {
    cursor.leb();
    if (opcode !== 0x3f) cursor.leb();
  } else if (opcode === 0x0e) {
    for (let count = cursor.leb(); count >= 0; count--) cursor.leb();
  } else if (opcode === 0x1c) {
    for (let count = cursor.leb(); count > 0; count--) valueType(cursor);
  } else if (opcode === 0x1f) tryTable(cursor);
  else if (opcode === 0x41 || opcode === 0x42 || opcode === 0xd0) cursor.leb();
  else if (opcode === 0x43 || opcode === 0x44) cursor.skip(opcode === 0x43 ? 4 : 8);
  else if (opcode === 0xfc) bulk(cursor);
  else if (opcode === 0xfd) simd(cursor);
  else if (opcode === 0xfe) atomic(cursor);
  else invalid(cursor.member, `unsupported opcode 0x${opcode.toString(16)} in a group image`);
  return true;
}
function tryTable(cursor: Cursor): void {
  blockType(cursor);
  for (let count = cursor.leb(); count > 0; count--) {
    const kind = cursor.byte();
    if (kind < 2) cursor.leb();
    cursor.leb();
  }
}

function bodyGrowthFree(code: Cursor): boolean {
  const end = code.leb() + code.at;
  for (let groups = code.leb(); groups > 0; groups--) {
    code.leb();
    valueType(code);
  }
  while (code.at < end) if (!instruction(code)) return false;
  return true;
}

/** True when no function body of `bytes` contains memory.grow. */
export function growthFree(bytes: Uint8Array, member: string): boolean {
  const module = new Cursor(bytes, member);
  module.skip(8);
  while (module.at < bytes.length) {
    const id = module.byte(),
      size = module.leb(),
      end = module.at + size;
    if (id !== 10) {
      module.skip(size);
      continue;
    }
    const code = new Cursor(bytes.subarray(module.at, end), member);
    for (let count = code.leb(); count > 0; count--) if (!bodyGrowthFree(code)) return false;
    return true;
  }
  return true;
}
