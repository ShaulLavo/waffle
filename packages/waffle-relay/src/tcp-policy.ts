import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicAddress } from "./address.js";
import { canonicalDestination, canonicalOrigin, destinationKey } from "./tcp-destination.js";
import { MAX_OPEN_BYTES, TcpFailure, WINDOW_BYTES, type TcpTarget } from "./tcp-protocol.js";
import { tokenKey } from "./token.js";

export interface TcpDestination extends TcpTarget {
  readonly connect?: TcpTarget;
  readonly allowMail?: boolean;
}
export interface TcpLimits {
  readonly maxConnections: number;
  readonly maxConnectionsPerSubject: number;
  readonly attemptsPerMinute: number;
  readonly maxSubjects: number;
  readonly maxOpenBytes: number;
  readonly headerTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly windowBytes: number;
}
export interface TcpLog {
  readonly event: "open" | "close";
  readonly time: string;
  readonly id: number;
  readonly sub: string;
  readonly destination?: TcpTarget;
  readonly carrier: "websocket";
  readonly sentBytes: number;
  readonly receivedBytes: number;
  readonly durationMs: number;
  readonly reason?: string;
}
export interface TcpServerOptions {
  readonly tokenSecret: string | Uint8Array;
  readonly destinations?: readonly TcpDestination[];
  readonly limits?: Partial<TcpLimits>;
  readonly issuer?: {
    readonly credential: string;
    readonly ttlSeconds: number;
    readonly destinations: readonly TcpTarget[];
  };
  readonly log?: (event: TcpLog) => void;
}
const defaults: TcpLimits = {
  maxConnections: 64,
  maxConnectionsPerSubject: 16,
  attemptsPerMinute: 30,
  maxSubjects: 4096,
  maxOpenBytes: MAX_OPEN_BYTES,
  headerTimeoutMs: 5000,
  connectTimeoutMs: 10000,
  idleTimeoutMs: 900000,
  windowBytes: WINDOW_BYTES,
};
export function tcpLimits(input?: Partial<TcpLimits>): TcpLimits {
  const limits = { ...defaults, ...input };
  for (const [key, value] of Object.entries(limits)) {
    if (
      !Number.isSafeInteger(value) ||
      value < (key === "idleTimeoutMs" ? 0 : 1) ||
      value > 2147483647
    )
      throw new TypeError("Invalid TCP limit");
  }
  if (limits.maxOpenBytes > MAX_OPEN_BYTES || limits.windowBytes > WINDOW_BYTES)
    throw new TypeError("TCP header/window limit exceeds protocol maximum");
  return Object.freeze(limits);
}
export function tcpPolicy(options: TcpServerOptions, allowedOrigins: readonly string[]) {
  const secret =
    typeof options.tokenSecret === "string"
      ? new TextEncoder().encode(options.tokenSecret)
      : new Uint8Array(options.tokenSecret);
  if (secret.length < 32) throw new TypeError("TCP token secret must contain at least 32 bytes");
  const destinations = new Map<string, TcpDestination>();
  for (const entry of options.destinations ?? []) {
    const target = canonicalDestination(entry);
    const connect = entry.connect && canonicalDestination(entry.connect);
    if (connect && !isIP(connect.host))
      throw new TypeError("TCP overrides must be numeric addresses");
    if (
      ([25, 465, 587].includes(target.port) ||
        (connect && [25, 465, 587].includes(connect.port))) &&
      entry.allowMail !== true
    )
      throw new TypeError("Mail ports require allowMail");
    if (destinations.has(destinationKey(target))) throw new TypeError("Duplicate TCP destination");
    destinations.set(destinationKey(target), { ...target, ...(connect ? { connect } : {}) });
  }
  const issuer = options.issuer;
  if (issuer && new TextDecoder().decode(secret) === issuer.credential)
    throw new TypeError("Issuer and TCP secrets must be distinct");
  if (
    issuer &&
    (!/^[\x21-\x7e]{32,4096}$/.test(issuer.credential) ||
      !Number.isInteger(issuer.ttlSeconds) ||
      issuer.ttlSeconds < 1 ||
      issuer.ttlSeconds > 86400)
  )
    throw new TypeError("Invalid TCP issuer configuration");
  const scope = issuer?.destinations.map(canonicalDestination);
  if (scope?.some((entry) => !destinations.has(destinationKey(entry))))
    throw new TypeError("Issuer scope exceeds TCP allowlist");
  return {
    destinations,
    origins: new Set(allowedOrigins.map(canonicalOrigin)),
    key: tokenKey(secret),
    secret,
    issuer: issuer && { ...issuer, destinations: scope! },
    limits: tcpLimits(options.limits),
    log:
      options.log ??
      ((event: TcpLog) => {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      }),
  };
}
export type TcpPolicy = ReturnType<typeof tcpPolicy>;
export type Resolver = (host: string) => Promise<readonly { address: string; family: number }[]>;
const resolveAll: Resolver = (host) => lookup(host, { all: true, verbatim: true });
/** Internal test seam. The dialer always receives this numeric result, never the DNS name. */
export async function resolveDestination(
  entry: TcpDestination,
  resolve: Resolver = resolveAll,
): Promise<TcpTarget> {
  if (entry.connect) return entry.connect;
  let answers: readonly { address: string; family: number }[];
  try {
    answers = isIP(entry.host)
      ? [{ address: entry.host, family: isIP(entry.host) }]
      : await resolve(entry.host);
  } catch {
    throw new TcpFailure("dns-failed");
  }
  if (!answers.length) throw new TcpFailure("dns-failed");
  if (answers.some(({ address, family }) => !isPublicAddress(address) || isIP(address) !== family))
    throw new TcpFailure("destination-denied");
  return { host: answers[0]!.address, port: entry.port };
}
export class TcpAdmissions {
  private subjects = new Map<string, { active: number; attempts: number; start: number }>();
  active = 0;
  constructor(private limits: TcpLimits) {}
  reserve(): () => void {
    if (this.active >= this.limits.maxConnections) throw new TcpFailure("limit");
    this.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
      }
    };
  }
  subject(key: string, now = Date.now()): () => void {
    this.sweep(now);
    let subject = this.subjects.get(key);
    if (!subject) {
      if (this.subjects.size >= this.limits.maxSubjects) throw new TcpFailure("limit");
      subject = { active: 0, attempts: 0, start: now };
      this.subjects.set(key, subject);
    }
    if (now - subject.start >= 60000) {
      subject.attempts = 0;
      subject.start = now;
    }
    if (
      ++subject.attempts > this.limits.attemptsPerMinute ||
      subject.active >= this.limits.maxConnectionsPerSubject
    )
      throw new TcpFailure("limit");
    subject.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        subject.active--;
      }
    };
  }
  private sweep(now: number): void {
    for (const [key, value] of this.subjects)
      if (!value.active && now - value.start >= 60000) this.subjects.delete(key);
  }
}
