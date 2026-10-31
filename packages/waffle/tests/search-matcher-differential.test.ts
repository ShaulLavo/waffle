import { expect, test } from "bun:test";
import { compileMatcher, searchFile } from "../search/matcher.js";
import type { MatcherPlan, OutputPlan } from "../search/types.js";

const encoder = new TextEncoder();
const native = Bun.which("rg") !== null && Bun.which("grep") !== null;
const modes: readonly OutputPlan[] = [
  { kind: "lines", withFilename: false, lineNumbers: false },
  { kind: "lines", withFilename: true, lineNumbers: true },
  { kind: "count", withFilename: false, zeroCounts: false },
  { kind: "files-with-matches" },
];

function oracle(
  tool: "rg" | "grep",
  plan: MatcherPlan,
  output: OutputPlan,
  bytes: Uint8Array,
  locale: string,
) {
  const args = [tool, "-a"];
  if (tool === "rg") args.push("--color=never", "--no-heading");
  if (plan.kind === "literal") args.push("-F");
  if (plan.kind === "regex" && tool === "grep") args.push("-E");
  if (plan.ignoreCase) args.push("-i");
  if (output.kind === "count") args.push("-c");
  if (output.kind === "files-with-matches") args.push("-l");
  if (output.kind === "lines" && output.lineNumbers) args.push("-n");
  if (output.kind !== "files-with-matches") args.push(output.withFilename ? "-H" : "--no-filename");
  if (plan.kind === "literal") for (const pattern of plan.patterns) args.push("-e", pattern);
  if (plan.kind === "regex") args.push("-e", plan.source);
  args.push("--", "-");
  const result = Bun.spawnSync(args, {
    stdin: Buffer.from(bytes),
    env: { ...process.env, LC_ALL: locale, RIPGREP_CONFIG_PATH: "" },
  });
  expect(result.stderr.length).toBe(0);
  return result;
}

function compare(
  tool: "rg" | "grep",
  plan: MatcherPlan,
  output: OutputPlan,
  bytes: Uint8Array,
  locale: string,
) {
  const admitted = compileMatcher(plan, tool, locale);
  if (admitted.kind === "fallback") throw new Error(admitted.reason);
  const selected = output.kind === "count" ? { ...output, zeroCounts: tool === "grep" } : output;
  const path = tool === "rg" ? "<stdin>" : "(standard input)";
  const actual = searchFile(bytes, path, admitted.matcher, selected);
  const expected = oracle(tool, plan, selected, bytes, locale);
  expect(
    new Bun.CryptoHasher("sha256").update(actual.output ?? new Uint8Array()).digest("hex"),
  ).toBe(new Bun.CryptoHasher("sha256").update(expected.stdout).digest("hex"));
  expect(actual.matched > 0 ? 0 : 1).toBe(expected.exitCode);
}

function generatedBytes(): Uint8Array {
  const records = [
    "",
    "a",
    "A",
    "aba",
    "ababa",
    "workUnitAsyncStorage",
    "CREATEserver",
    "require require",
    "none",
    "a.*+$[]|\\",
    "K",
    "ſ",
    "ı",
    "İ",
    "KSSı",
    "aKſi",
    "aKſı",
    "\0a",
  ];
  let seed = 8173;
  const alphabet = "abABksKiIS._ /|";
  for (let record = 0; record < 80; record++) {
    let text = "";
    for (let index = 0; index < record % 31; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      text += alphabet[seed % alphabet.length];
    }
    records.push(text);
  }
  return encoder
    .encode(records.join("\r\n") + "\nunterminated hit")
    .map((byte, index) => (index === 5 ? 255 : byte));
}

test.skipIf(!native)(
  "generated literal/alternation inputs are byte-exact against native rg and grep",
  () => {
    const plans: readonly MatcherPlan[] = [
      { kind: "regex", source: "aksi|aksiZ", ignoreCase: true },
      { kind: "literal", patterns: ["ababacab"], ignoreCase: false },
      { kind: "literal", patterns: ["a"], ignoreCase: false },
      { kind: "literal", patterns: ["a.*+$[]|\\", "hit"], ignoreCase: false },
      { kind: "literal", patterns: ["k", "s", "i"], ignoreCase: true },
      { kind: "regex", source: "a|aba|ababa", ignoreCase: false },
      { kind: "regex", source: "workUnitAsyncStorage|createServer", ignoreCase: true },
      { kind: "regex", source: "k|s|i", ignoreCase: true },
      { kind: "literal", patterns: ["absent_729f3d"], ignoreCase: false },
    ];
    const inputs = [
      generatedBytes(),
      new Uint8Array(),
      encoder.encode("a\r\nA\na"),
      new Uint8Array([255, 97, 10, 97, 0, 10]),
    ];
    for (const tool of ["rg", "grep"] as const) verifyTool(tool, plans, inputs);
  },
  20000,
);

function verifyTool(
  tool: "rg" | "grep",
  plans: readonly MatcherPlan[],
  inputs: readonly Uint8Array[],
) {
  for (const locale of ["C", "C.UTF-8"]) verifyLocale(tool, locale, plans, inputs);
}

function verifyLocale(
  tool: "rg" | "grep",
  locale: string,
  plans: readonly MatcherPlan[],
  inputs: readonly Uint8Array[],
) {
  for (const plan of plans) verifyPlan(tool, locale, plan, inputs);
}

function verifyPlan(
  tool: "rg" | "grep",
  locale: string,
  plan: MatcherPlan,
  inputs: readonly Uint8Array[],
) {
  for (const output of modes) {
    for (const input of inputs) compare(tool, plan, output, input, locale);
  }
}

test.skipIf(!native)(
  "every non-ASCII Unicode scalar has the qualified ASCII-letter folds",
  () => {
    const scalars: string[] = [];
    for (let scalar = 128; scalar <= 0x10ffff; scalar++) {
      if (scalar >= 0xd800 && scalar <= 0xdfff) continue;
      scalars.push(String.fromCodePoint(scalar));
    }
    const bytes = encoder.encode(scalars.join("\n"));
    for (const tool of ["rg", "grep"] as const) verifyUnicode(tool, bytes);
  },
  20000,
);

function verifyUnicode(tool: "rg" | "grep", bytes: Uint8Array) {
  for (const locale of ["C", "C.UTF-8"]) {
    for (const pattern of ["abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"])
      verifyAlphabet(tool, locale, bytes, pattern);
  }
}

function verifyAlphabet(tool: "rg" | "grep", locale: string, bytes: Uint8Array, alphabet: string) {
  const plan = {
    kind: "regex",
    source: Array.from(alphabet).join("|"),
    ignoreCase: true,
  } satisfies MatcherPlan;
  compare(tool, plan, { kind: "lines", withFilename: false, lineNumbers: false }, bytes, locale);
  for (const character of alphabet) {
    const candidate = { kind: "regex", source: character, ignoreCase: true } satisfies MatcherPlan;
    compare(
      tool,
      candidate,
      { kind: "lines", withFilename: false, lineNumbers: false },
      encoder.encode("K\nſ\nı\nİ\n"),
      locale,
    );
  }
}
