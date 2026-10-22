export const opfsCloseArms = ["native-success", "injected-error", "injected-undefined"] as const;
export type OpfsCloseArm = (typeof opfsCloseArms)[number];
export type OpfsCloseCommand =
  | { kind: "prepare"; storageName: string; arm: OpfsCloseArm }
  | { kind: "close" }
  | { kind: "inspect"; retained: boolean }
  | { kind: "probe"; storageName: string; held: "both" | "first" | "none" }
  | { kind: "reopen"; storageName: string }
  | { kind: "delete"; storageName: string };
export interface OpfsCloseRequest {
  id: number;
  command: OpfsCloseCommand;
}
export interface OpfsCloseReply {
  id: number;
  status: "ok" | "setup-invalid" | "behavioral-red";
  receipt: Record<string, unknown>;
}
export interface OpfsCloseObserverFailure {
  token: string;
  event: "error" | "messageerror" | "reply" | "postMessage" | "terminate";
  reason: Record<string, unknown>;
}
export interface OpfsClosePage {
  start(token: string): void;
  request(token: string, command: OpfsCloseCommand): Promise<OpfsCloseReply>;
  terminateAll(): string[];
  failures(): OpfsCloseObserverFailure[];
}
declare global {
  interface Window {
    opfsClose: OpfsClosePage;
  }
}
export class OpfsCloseSetupInvalid extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpfsCloseSetupInvalid";
  }
}
export function requireProof(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export function isOpfsCloseArm(value: unknown): value is OpfsCloseArm {
  return value === "native-success" || value === "injected-error" || value === "injected-undefined";
}
export function reasonReceipt(reason: unknown): Record<string, unknown> {
  if (reason === undefined) return { type: "undefined" };
  if (reason === null) return { type: "null" };
  if (reason instanceof AggregateError)
    return {
      type: "aggregate-error",
      name: reason.name,
      message: reason.message,
      errors: Array.from(reason.errors, reasonReceipt),
    };
  if (reason instanceof Error)
    return {
      type: "error",
      name: reason.name,
      message: reason.message,
      stack: reason.stack,
      cause: "cause" in reason ? reasonReceipt(reason.cause) : null,
    };
  if (typeof reason === "number")
    return { type: "number", value: Object.is(reason, -0) ? "-0" : String(reason) };
  if (typeof reason === "object") return { type: "object", identity: "same-realm only" };
  return { type: typeof reason, value: String(reason) };
}
export function parseOpfsCloseReply(value: unknown): OpfsCloseReply {
  if (!value || typeof value !== "object") throw new OpfsCloseSetupInvalid("Invalid Worker reply");
  if (!("id" in value) || typeof value.id !== "number" || !Number.isSafeInteger(value.id))
    throw new OpfsCloseSetupInvalid("Invalid Worker reply id");
  if (
    !("status" in value) ||
    !["ok", "setup-invalid", "behavioral-red"].includes(String(value.status))
  )
    throw new OpfsCloseSetupInvalid("Invalid Worker reply status");
  if (!("receipt" in value) || !value.receipt || typeof value.receipt !== "object")
    throw new OpfsCloseSetupInvalid("Invalid Worker receipt");
  const receipt = Object.fromEntries(Object.entries(value.receipt));
  if (
    value.status === "ok" ||
    value.status === "setup-invalid" ||
    value.status === "behavioral-red"
  )
    return { id: value.id, status: value.status, receipt };
  throw new OpfsCloseSetupInvalid("Invalid Worker reply status");
}
export function parseOpfsCloseCommand(value: unknown): OpfsCloseCommand {
  if (!value || typeof value !== "object" || !("kind" in value))
    throw new OpfsCloseSetupInvalid("Invalid Worker command");
  if (value.kind === "close") return { kind: "close" };
  if (value.kind === "inspect" && "retained" in value && typeof value.retained === "boolean")
    return { kind: "inspect", retained: value.retained };
  if (
    !("storageName" in value) ||
    typeof value.storageName !== "string" ||
    !/^waffle-u2g-r2-[0-9a-f-]{36}$/.test(value.storageName)
  )
    throw new OpfsCloseSetupInvalid("Only unique task storage names are permitted");
  const storageName = value.storageName;
  if (value.kind === "reopen" || value.kind === "delete") return { kind: value.kind, storageName };
  if (value.kind === "prepare" && "arm" in value && isOpfsCloseArm(value.arm))
    return { kind: "prepare", storageName, arm: value.arm };
  if (
    value.kind === "probe" &&
    "held" in value &&
    (value.held === "both" || value.held === "first" || value.held === "none")
  )
    return { kind: "probe", storageName, held: value.held };
  throw new OpfsCloseSetupInvalid("Unknown Worker command");
}
