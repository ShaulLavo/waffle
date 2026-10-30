import { GhError } from "./errors.ts";
import { encode, stableJson } from "./json.ts";
import type { Invocation, JsonValue } from "./types.ts";

export type OutputFormat =
  | { readonly kind: "plain" }
  | { readonly kind: "json"; readonly fields: readonly string[]; readonly jq?: string };

export async function writeText(
  invocation: Invocation,
  stream: "stdout" | "stderr",
  text: string,
): Promise<void> {
  if (text) await invocation[stream](encode(text));
}

export async function emitJson(
  invocation: Invocation,
  value: JsonValue,
  format: Exclude<OutputFormat, { kind: "plain" }>,
): Promise<void> {
  if (!format.jq) {
    await writeText(invocation, "stdout", `${stableJson(value)}\n`);
    return;
  }
  await evaluate(invocation, format.jq, value);
}

export async function evaluate(invocation: Invocation, expression: string, value: JsonValue) {
  if (!invocation.evaluator) throw new GhError("gh: --jq requires the installed /usr/bin/jq program");
  const output = await invocation.evaluator(expression, value, {
    cwd: invocation.cwd,
    env: invocation.env,
  });
  await writeText(invocation, "stdout", output);
}
