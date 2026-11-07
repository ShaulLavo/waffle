/** Schema-only tooling model. These are wire fields, never native C memory layouts. */
export interface Field {
  name: string;
  type: string;
  optional: boolean;
}

interface StructLayout {
  fields: Field[];
}

export type Result =
  | { kind: "void" }
  | { kind: "handle"; object: string; source: "return" | "callback" | "output" }
  | { kind: "scalar"; type: string };

export type Lowering =
  | { kind: "label"; target: "native" | "surface-reference" }
  | { kind: "method"; member: string }
  | { kind: "descriptor-method"; member: string; descriptor: string }
  | {
      kind: "write-buffer" | "write-texture" | "set-immediates";
      member: string;
      span: { pointer: "data"; size: "size" | "data_size" };
    }
  | { kind: "property"; member: "queue" }
  | { kind: "request-adapter"; descriptor: "adapter-options" }
  | { kind: "request-device"; descriptor: "device-descriptor" }
  | { kind: "surface-create"; descriptor: "waffle-surface" }
  | { kind: "surface-configure"; descriptor: "stable-frame" }
  | { kind: "surface-acquire"; output: "surface_texture" }
  | { kind: "surface-present"; result: "enum.status" }
  | { kind: "shader-module"; descriptor: "wgsl-chain" }
  | { kind: "render-pipeline"; descriptor: "auto-layout" }
  | { kind: "error-scope"; member: "pushErrorScope" | "popErrorScope" };

export interface CallLayout {
  opcode: number;
  name: string;
  receiver: string;
  context: "top" | "encoder" | "pass" | "bundle";
  result: Result;
  cReturn: string;
  callback: null | {
    type: string;
    future: "token-as-future-id";
    delivery: "guest-local-completion-pump";
    omitted: string[];
  };
  token: string | null;
  lowering: Lowering;
  omitted: string[];
  fields: Field[];
}

export interface WireTables {
  root: { object: string; id: number; generation: number };
  calls: CallLayout[];
  structs: Record<string, StructLayout>;
  enums: Record<string, Record<string, number>>;
  browserEnums: Record<string, Record<string, string | number | null>>;
  chains: Record<string, { sType: number; struct: string }[]>;
  completions: { name: string; kind: number; fields: Field[] }[];
  records: { name: string; opcode: number; enabled: boolean; fields: Field[] }[];
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return value as Record<string, unknown>;
}

export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected array");
  return value;
}

export function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}

export function uint(value: unknown, max = 0xffffffff): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max)
    throw new Error("Integer outside wire bounds");
  return value;
}

export function fields(value: unknown): Field[] {
  return list(value).map((item) => {
    const field = record(item);
    return { name: text(field.name), type: text(field.type), optional: field.optional === true };
  });
}
