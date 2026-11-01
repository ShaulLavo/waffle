import { readFile, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { canonicalDestination, canonicalOrigin } from "./tcp-destination.js";
import { record } from "./tcp-protocol.js";
import { tcpLimits, type TcpDestination, type TcpServerOptions } from "./tcp-policy.js";
import type { NodeRelayOptions } from "./node.js";
import type { TcpWebTransportOptions, NodeWebTransportRelayOptions } from "./node-webtransport.js";

export interface ServeConfig {
  readonly listen: { host: string; port: number };
  readonly options: NodeRelayOptions | NodeWebTransportRelayOptions;
  readonly dev: boolean;
}
export async function serveConfig(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServeConfig> {
  if (args[0] !== "serve")
    throw new TypeError(
      "Use waffle-relay serve --config <file> or serve --dev --destination <host,port,numeric-host,port>",
    );
  const flags = parseFlags(args.slice(1));
  if (flags.has("--dev")) return devConfig(flags);
  if (flags.size !== 1 || !flags.has("--config"))
    throw new TypeError("Use a config file outside development mode");
  const value: unknown = JSON.parse(await readFile(one(flags, "--config")!, "utf8"));
  if (
    !record(value) ||
    !record(value.listen) ||
    !record(value.tcp) ||
    !Array.isArray(value.allowedOrigins)
  )
    throw new TypeError("Invalid relay configuration");
  rejectKeys(value, ["listen", "allowedOrigins", "tcp"]);
  rejectKeys(value.listen, ["host", "port"]);
  rejectKeys(value.tcp, ["tokenSecretFile", "destinations", "issuer", "limits", "webtransport"]);
  const listen = listenFrom(value.listen);
  const origins = value.allowedOrigins.map((origin: unknown) => {
    if (typeof origin !== "string") throw new TypeError("Invalid origin");
    return canonicalOrigin(origin);
  });
  const secret = env.WAFFLE_RELAY_TOKEN_SECRET ?? (await secretFile(value.tcp.tokenSecretFile));
  const destinations = destinationsFrom(value.tcp.destinations);
  const limits = limitsFrom(value.tcp.limits);
  const issuer = await issuerFrom(value.tcp.issuer, env);
  const webtransport = await webtransportFrom(value.tcp.webtransport);
  if (issuer?.credential === secret) throw new TypeError("Issuer and TCP secrets must be distinct");
  return {
    listen,
    dev: false,
    options: {
      credential: randomBytes(32).toString("hex"),
      allowedOrigins: origins,
      tcp: {
        tokenSecret: secret,
        destinations,
        limits,
        ...(issuer ? { issuer } : {}),
        ...(webtransport ? { webtransport } : {}),
      },
    },
  };
}
function parseFlags(args: readonly string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (!["--config", "--dev", "--listen", "--port", "--origin", "--destination"].includes(key))
      throw new TypeError("Unknown relay flag");
    const value = key === "--dev" ? "true" : args[++i];
    if (!value || value.startsWith("--")) throw new TypeError("Missing relay flag value");
    const previous = flags.get(key) ?? [];
    previous.push(value);
    flags.set(key, previous);
  }
  return flags;
}
function one(flags: Map<string, string[]>, key: string): string | undefined {
  const values = flags.get(key);
  if (values && values.length !== 1) throw new TypeError("Repeated relay flag");
  return values?.[0];
}
function devConfig(flags: Map<string, string[]>): ServeConfig {
  if (flags.has("--config"))
    throw new TypeError("Development mode never loads an issuer or persistent config");
  one(flags, "--dev");
  const listen = listenFrom({
    host: one(flags, "--listen") ?? "127.0.0.1",
    port: Number(one(flags, "--port") ?? 8787),
  });
  if (!["127.0.0.1", "::1"].includes(listen.host))
    throw new TypeError("Development relay must listen on numeric loopback");
  const origins = (flags.get("--origin") ?? ["http://localhost:3000"]).map(canonicalOrigin);
  const destinations = (flags.get("--destination") ?? []).map((value) => {
    const parts = value.split(",");
    if (parts.length !== 4)
      throw new TypeError("Development destination is host,port,numeric-host,port");
    const target = canonicalDestination({ host: parts[0]!, port: Number(parts[1]) });
    const connect = canonicalDestination({ host: parts[2]!, port: Number(parts[3]) });
    if (!["127.0.0.1", "::1"].includes(connect.host))
      throw new TypeError("Development targets must use explicit numeric loopback overrides");
    return { ...target, connect };
  });
  if (!destinations.length)
    throw new TypeError("Development mode requires at least one destination");
  return {
    listen,
    dev: true,
    options: {
      credential: randomBytes(32).toString("hex"),
      allowedOrigins: origins,
      tcp: { tokenSecret: randomBytes(32), destinations },
    },
  };
}
async function webtransportFrom(value: unknown): Promise<TcpWebTransportOptions | undefined> {
  if (value === undefined) return;
  if (!record(value) || typeof value.host !== "string" || typeof value.port !== "number")
    throw new TypeError("Invalid WebTransport config");
  rejectKeys(value, ["host", "port", "certificate", "rotationMs"]);
  let certificate: TcpWebTransportOptions["certificate"];
  if (value.certificate === undefined || value.certificate === "rotating-hash") {
    certificate = value.certificate;
  } else {
    if (
      !record(value.certificate) ||
      typeof value.certificate.certFile !== "string" ||
      typeof value.certificate.keyFile !== "string"
    )
      throw new TypeError("Invalid WebTransport certificate config");
    rejectKeys(value.certificate, ["certFile", "keyFile"]);
    certificate = {
      cert: await readFile(value.certificate.certFile, "utf8"),
      key: await secretFile(value.certificate.keyFile),
    };
  }
  return {
    host: value.host,
    port: value.port,
    ...(certificate ? { certificate } : {}),
    ...(value.rotationMs === undefined ? {} : { rotationMs: rotationFrom(value.rotationMs) }),
  };
}
function rotationFrom(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1000 ||
    value > 12 * 86400000
  )
    throw new TypeError("Invalid WebTransport rotation interval");
  return value;
}

function listenFrom(value: Record<string, unknown>): ServeConfig["listen"] {
  if (
    typeof value.host !== "string" ||
    !isIP(value.host) ||
    typeof value.port !== "number" ||
    !Number.isInteger(value.port) ||
    value.port < 0 ||
    value.port > 65535
  )
    throw new TypeError("Relay listen requires a numeric address and integer port");
  return { host: value.host, port: value.port };
}
function destinationsFrom(value: unknown): TcpDestination[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) throw new TypeError("Invalid TCP destinations");
  return value.map(destinationFrom);
}
function destinationFrom(value: unknown): TcpDestination {
  if (!record(value) || typeof value.host !== "string" || typeof value.port !== "number")
    throw new TypeError("Invalid TCP destination");
  rejectKeys(value, ["host", "port", "connect", "allowMail"]);
  let connect: ReturnType<typeof canonicalDestination> | undefined;
  if (value.connect !== undefined) {
    if (
      !record(value.connect) ||
      typeof value.connect.host !== "string" ||
      typeof value.connect.port !== "number"
    )
      throw new TypeError("Invalid TCP override");
    rejectKeys(value.connect, ["host", "port"]);
    connect = canonicalDestination({ host: value.connect.host, port: value.connect.port });
  }
  if (value.allowMail !== undefined && typeof value.allowMail !== "boolean")
    throw new TypeError("Invalid mail permission");
  return {
    ...canonicalDestination({ host: value.host, port: value.port }),
    ...(connect ? { connect } : {}),
    ...(value.allowMail === true ? { allowMail: true } : {}),
  };
}
async function issuerFrom(
  value: unknown,
  env: NodeJS.ProcessEnv,
): Promise<TcpServerOptions["issuer"]> {
  if (value === undefined) return;
  if (!record(value) || typeof value.ttlSeconds !== "number")
    throw new TypeError("Invalid issuer config");
  rejectKeys(value, ["credentialFile", "ttlSeconds", "destinations"]);
  const credential = env.WAFFLE_RELAY_ISSUER_CREDENTIAL ?? (await secretFile(value.credentialFile));
  return {
    credential,
    ttlSeconds: value.ttlSeconds,
    destinations: destinationsFrom(value.destinations),
  };
}
async function secretFile(path: unknown): Promise<string> {
  if (typeof path !== "string")
    throw new TypeError("Configure a protected secret file or environment variable");
  const info = await stat(path);
  if (
    !info.isFile() ||
    (info.mode & 0o777) !== 0o600 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new TypeError("Secret file must be owner-owned mode 0600");
  const value = (await readFile(path, "utf8")).trim();
  if (new TextEncoder().encode(value).length < 32)
    throw new TypeError("Secret must contain at least 32 bytes");
  return value;
}
function rejectKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new TypeError("Unknown relay configuration field");
}
function limitsFrom(value: unknown): ReturnType<typeof tcpLimits> {
  if (value === undefined) return tcpLimits();
  if (!record(value)) throw new TypeError("Invalid TCP limits");
  const defaults = tcpLimits();
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
    const selected = value[key];
    if (selected !== undefined && typeof selected !== "number")
      throw new TypeError("Invalid TCP limit");
    if (selected !== undefined) result[key] = selected;
  }
  rejectKeys(value, Object.keys(defaults));
  return tcpLimits(result);
}

export async function tcpStartup(
  tcp:
    | {
        readonly ready: Promise<void>;
        readonly failure?: Promise<import("./webtransport-lifecycle.js").EndpointFailure>;
      }
    | undefined,
): Promise<void> {
  try {
    await tcp?.ready;
  } catch (error) {
    const failure = await tcp?.failure;
    if (!failure?.manualActionRequired) throw error;
  }
}
