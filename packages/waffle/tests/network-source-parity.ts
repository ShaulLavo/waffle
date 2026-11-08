import { parseSync } from "oxc-parser";
import { createHash } from "node:crypto";

type Node = Record<string, unknown>;
function object(value: unknown): value is Node {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function canonical(value: unknown): string {
  return JSON.stringify(clean(value));
}
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => !["start", "end", "raw", "comments"].includes(key))
      .map((key) => [key, clean(value[key])]),
  );
}
function source(text: string): Node[] {
  const parsed = parseSync("network.ts", text);
  if (parsed.errors.length)
    throw new Error(`Parity parse failed: ${JSON.stringify(parsed.errors)}`);
  const nodes: readonly unknown[] = parsed.program.body;
  return nodes.filter(object);
}
function parsedNode(text: string): Node | undefined {
  const node = source(text)[0];
  return node?.type === "ExpressionStatement" && object(node.expression) ? node.expression : node;
}
const substitutions = [
  ['import type { OwnedServiceWorker } from "waffle/testing/page-runner/page";', ""],
  ['import { finishNetworkCase } from "./network-finalizer.js";', ""],
  [
    "export interface NetworkBrowserEnvironment { readonly serviceWorker: OwnedServiceWorker; }",
    "",
  ],
  [
    'const directServiceWorker: OwnedServiceWorker = { register: () => navigator.serviceWorker.register("/network-sw.js", { scope: "/", type: "module" }), controls: (_registration, controller) => controller !== null, unregister: (registration) => registration.unregister() };',
    "",
  ],
  ["let primary: { error: unknown } | undefined;", ""],
  [
    "await serviceWorker.register()",
    'await navigator.serviceWorker.register("/network-sw.js", { scope: "/", type: "module" })',
  ],
  [
    "await until(() => Promise.resolve(serviceWorker.controls(registration!, navigator.serviceWorker.controller)), (value) => value === true)",
    "await until(() => Promise.resolve(navigator.serviceWorker.controller), (value) => value !== null)",
  ],
  [
    'check(serviceWorker.controls(registration, navigator.serviceWorker.controller), "Preview controller identity changed");',
    "",
  ],
  [
    'export interface RelayBrowserEnvironment { readonly fetchFixture: (path: "/relay-config" | "/relay-idle") => Promise<Response>; }',
    "",
  ],
  [
    "const directEnvironment: RelayBrowserEnvironment = { fetchFixture: (path) => fetch(path) };",
    "",
  ],
  ['await environment.fetchFixture("/relay-idle")', 'await fetch("/relay-idle")'],
  ['await environment.fetchFixture("/relay-config")', 'await fetch("/relay-config")'],
  ["await idle(environment)", "await idle()"],
  ["await mode(config, selected, environment)", "await mode(config, selected)"],
  ["signal?.throwIfAborted();", ""],
  [
    'await waitFor(() => sockets.size === 0 && (relay?.tcp?.active ?? 0) === 0, "relay and target disposal", signal)',
    'await waitFor(() => sockets.size === 0 && (relay?.tcp?.active ?? 0) === 0, "relay and target disposal")',
  ],
] as const;
const finalizer =
  '{ await finishNetworkCase(primary, guests.map((item) => () => item.retire()).concat([async () => { if (registration) await serviceWorker.unregister(registration); }, () => navigator.serviceWorker.removeEventListener("message", route), () => isolatedNamespace.dispose(), () => runtime.dispose()])); }';
const originalFinalizer =
  '{ for (const item of guests) item.retire(); await registration?.unregister(); navigator.serviceWorker.removeEventListener("message", route); isolatedNamespace.dispose(); await runtime.dispose(); }';
const signatures: Record<string, [string, string]> = {
  networkBrowserCases: [
    "{ serviceWorker }: NetworkBrowserEnvironment = { serviceWorker: directServiceWorker }",
    "",
  ],
  idle: ["environment: RelayBrowserEnvironment", ""],
  mode: [
    "config: RelayBrowserConfig, selected: RelayMode, environment: RelayBrowserEnvironment",
    "config: RelayBrowserConfig, selected: RelayMode",
  ],
  networkRelayBrowserCases: ["environment: RelayBrowserEnvironment = directEnvironment", ""],
};

function functionNode(statement: Node): Node {
  return statement.type === "ExportNamedDeclaration" && object(statement.declaration)
    ? statement.declaration
    : statement;
}
function parameters(text: string): unknown {
  return source(`function f(${text}) {}`)[0]?.params;
}
function functionName(node: Node): string | undefined {
  return object(node.id) && typeof node.id.name === "string" ? node.id.name : undefined;
}
const handler = parsedNode("try {} catch (error) { primary = { error }; throw error; }")?.handler;
const originalBlock = source(`async function f() ${originalFinalizer}`)[0]?.body;
const finalBlock = source(`async function f() ${finalizer}`)[0]?.body;
/** Hermetic parsed-node comparison, with only the reviewed environment and finalizer substitutions. */
export function networkParity(text: string, adapted: boolean): Record<string, string> {
  const statements = source(text);
  if (adapted) requireAdaptations(statements);
  const rules = new Map<string, unknown>();
  for (const [actual, original] of substitutions) {
    rules.set(canonical(parsedNode(actual)), original ? parsedNode(original) : undefined);
    if (actual.endsWith(";"))
      rules.set(canonical(source(actual)[0]), original ? source(original)[0] : undefined);
  }
  rules.set(canonical(finalBlock), originalBlock);
  function normalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalize).filter((item) => item !== undefined);
    if (!object(value)) return value;
    const key = canonical(value);
    if (adapted && rules.has(key)) return clean(rules.get(key));
    const name = functionName(value),
      signature = name ? signatures[name] : undefined;
    const result: Node = {};
    for (const [field, child] of Object.entries(value)) {
      if (adapted && field === "handler" && canonical(child) === canonical(handler)) {
        result[field] = null;
        continue;
      }
      const fixtureSignature =
        field === "params"
          ? [
              [
                "origin: string, native: boolean, signal?: AbortSignal",
                "origin: string, native: boolean",
              ],
              ["signal?: AbortSignal", ""],
              [
                "ready: () => boolean, label: string, signal?: AbortSignal",
                "ready: () => boolean, label: string",
              ],
            ].find(([actual]) => canonical(child) === canonical(parameters(actual!)))
          : undefined;
      if (adapted && field === "params" && fixtureSignature) {
        result[field] = clean(parameters(fixtureSignature[1]!));
        continue;
      }
      if (
        adapted &&
        field === "params" &&
        signature &&
        canonical(child) === canonical(parameters(signature[0]))
      ) {
        result[field] = clean(parameters(signature[1]));
        continue;
      }
      result[field] = normalize(child);
    }
    return clean(result);
  }
  const result: Record<string, string> = {};
  const nodes = statements.map(normalize).filter(object);
  for (const [index, statement] of nodes.entries()) {
    const node = functionNode(statement);
    result[`${index}:${functionName(node) ?? node.type}`] = createHash("sha256")
      .update(canonical(statement))
      .digest("hex");
  }
  return result;
}

function occurrences(value: unknown, key: string): number {
  if (Array.isArray(value))
    return value.reduce((count: number, item) => count + occurrences(item, key), 0);
  if (!object(value)) return 0;
  return (
    Number(canonical(value) === key) +
    Object.values(value).reduce<number>((count, child) => count + occurrences(child, key), 0)
  );
}
function requireAdaptations(statements: Node[]): void {
  const names = statements.map((statement) => functionName(functionNode(statement)));
  const network = names.includes("networkBrowserCases"),
    relay = names.includes("networkRelayBrowserCases");
  if (
    names.includes("createRelayBrowserFixture") &&
    occurrences(statements, canonical(source("signal?.throwIfAborted();")[0])) !== 12
  )
    throw new Error("Original relay fixture lost a cancellation acquisition boundary");
  if (!network && !relay) return;
  const required = network ? substitutions.slice(0, 8) : substitutions.slice(8, 14);
  for (const [text] of required) {
    const expected = text === "await idle(environment)" ? 3 : 1;
    if (occurrences(statements, canonical(parsedNode(text))) !== expected)
      throw new Error(`Unexpected network adaptation node: ${text}`);
  }
  if (
    network &&
    (occurrences(statements, canonical(handler)) !== 1 ||
      occurrences(statements, canonical(finalBlock)) !== 1)
  )
    throw new Error("Unexpected network finalizer or original primary error handler");
}
