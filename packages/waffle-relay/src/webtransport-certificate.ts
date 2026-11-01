import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { base64url } from "./token.js";

export interface CertificateMaterial {
  readonly cert: string;
  readonly key: string;
  readonly starts: number;
  readonly expires: number;
  readonly hash: { readonly algorithm: "sha-256"; readonly value: string };
}
const execute = promisify(execFile);
export async function createCertificate(
  signal?: AbortSignal,
  timeoutMs = 10000,
): Promise<CertificateMaterial> {
  const root =
    process.env.WAFFLE_RELAY_TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
  const directory = await mkdtemp(join(root, "waffle-relay-cert-"));
  try {
    const execution = execute(
      "openssl",
      [
        "req",
        "-new",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-days",
        "13",
        "-subj",
        "/CN=waffle-relay",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
      ],
      { timeout: Math.min(timeoutMs, 10000), maxBuffer: 32768, signal },
    );
    const closed = new Promise<void>((resolve) => execution.child.once("close", () => resolve()));
    try {
      await execution;
    } finally {
      await closed;
    }
    const cert = await readFile(join(directory, "cert.pem"), "utf8");
    const key = await readFile(join(directory, "key.pem"), "utf8");
    const parsed = new X509Certificate(cert);
    const digest = await crypto.subtle.digest("SHA-256", parsed.raw);
    return {
      cert,
      key,
      starts: Date.parse(parsed.validFrom),
      expires: Date.parse(parsed.validTo),
      hash: { algorithm: "sha-256", value: base64url(new Uint8Array(digest)) },
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
