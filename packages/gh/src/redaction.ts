import type { Invocation } from "./types.ts";

const encoder = new TextEncoder();
const replacement = encoder.encode("[REDACTED]");

export function withTokenRedaction(invocation: Invocation): Invocation {
  const secrets = new Set<string>();
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = invocation.env[name];
    if (value) secrets.add(value);
  }
  return {
    ...invocation,
    secrets,
    stdout: (bytes) => invocation.stdout(redactBytes(bytes, secrets)),
    stderr: (bytes) => invocation.stderr(redactBytes(bytes, secrets)),
  };
}

export function redactBytes(bytes: Uint8Array, secrets: ReadonlySet<string>): Uint8Array {
  let result = bytes;
  for (const secret of secrets) {
    if (secret) result = replaceSecret(result, encoder.encode(secret));
  }
  return result;
}

function replaceSecret(bytes: Uint8Array, secret: Uint8Array): Uint8Array {
  let matches = 0;
  for (
    let index = findSecret(bytes, secret, 0);
    index >= 0;
    index = findSecret(bytes, secret, index + secret.length)
  ) {
    matches++;
  }
  if (!matches) return bytes;
  const output = new Uint8Array(bytes.length + matches * (replacement.length - secret.length));
  let source = 0;
  let destination = 0;
  for (
    let index = findSecret(bytes, secret, 0);
    index >= 0;
    index = findSecret(bytes, secret, source)
  ) {
    output.set(bytes.subarray(source, index), destination);
    destination += index - source;
    output.set(replacement, destination);
    destination += replacement.length;
    source = index + secret.length;
  }
  output.set(bytes.subarray(source), destination);
  return output;
}

function findSecret(bytes: Uint8Array, secret: Uint8Array, start: number): number {
  if (secret.length === 0 || start + secret.length > bytes.length) return -1;
  for (let index = start; index <= bytes.length - secret.length; index++) {
    let matched = true;
    for (let offset = 0; offset < secret.length; offset++) {
      if (bytes[index + offset] !== secret[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }
  return -1;
}
