import { existsSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { API, type Project } from "typescript/unstable/async";
import * as ast from "typescript/unstable/ast";

/** Same-realm guest code can replace builtins after Worker initialization. */
export interface AuthorityFinding {
  file: string;
  line: number;
  scope: string;
  rule:
    | "mutable-builtin"
    | "mutable-getter"
    | "private-iteration"
    | "species"
    | "native-conversion"
    | "authority-global";
  expression: string;
}

// Capture modules run before guests. Other trusted implementations run only in
// the page/service realm. Reexports do not make their methods guest-reachable.
// New modules are NOT implicitly excluded.
const intrinsicModules: Readonly<Record<string, string>> = {
  "proc/intrinsics.ts": "Reexports the manually reviewed initialization-time capture modules.",
  "proc/intrinsics/core.ts":
    "Initialization-time core collection, typed-array and atomic captures, before guest execution.",
  "proc/intrinsics/host.ts":
    "Initialization-time shared-buffer, DataView, identity, timer and collection captures, before guest execution.",
};
const trustedModules: Readonly<Record<string, string>> = {
  ...intrinsicModules,
  "proc/supervisor.ts": "Page-owned supervisor, not imported by the guest bootstrap.",
  "proc/table.ts": "Page-owned process table, not imported by the guest bootstrap.",
  "proc/registry.ts": "Page-owned process registry, not imported by the guest bootstrap.",
  "proc/stub.ts": "Page-only lazy process facade, not a guest Worker implementation.",
  "proc/worker-broker.ts": "Page-owned message broker, not imported by the guest bootstrap.",
  "proc/node-wasi.ts": "Trusted Node embedding adapter, not imported by the guest bootstrap.",
  "fs/service.ts": "Filesystem service runs in its dedicated trusted Worker, not the guest realm.",
  "fs/backend.ts": "Backend used by the dedicated filesystem service.",
  "fs/persistent.ts": "Persistence backend used by the dedicated filesystem service.",
  "fs/indexeddb.ts": "Storage backend used by the dedicated filesystem service.",
  "fs/opfs.ts": "Storage backend used by the dedicated filesystem service.",
  "fs/storage.ts": "Storage interface for the dedicated filesystem service.",
  "core/memory-views.js":
    "Guest-owned WebAssembly memory view helpers; no private runtime buffers.",
};

interface PayloadException {
  file: string;
  scope: string;
  rule: AuthorityFinding["rule"];
  expression: string;
  reason: string;
}

// Exact expression + owning function, never a whole-file escape hatch. Changes
// here require a payload provenance explanation in docs/private-authority.md.
export const payloadExceptions: readonly PayloadException[] = [
  {
    file: "proc/pipes.ts",
    scope: "length",
    rule: "mutable-builtin",
    expression: "chunks.reduce((total, chunk) => total + typedArrayLength(chunk), 0)",
    reason:
      "Caller-owned byte iovecs; no private ring, cursor or endpoint is an element or callback capture.",
  },
  {
    file: "proc/pipes.ts",
    scope: "Ring.write",
    rule: "private-iteration",
    expression: "chunks",
    reason: "Caller-owned source iovecs; ring copies use captured natives.",
  },
  {
    file: "proc/pipes.ts",
    scope: "Ring.read",
    rule: "private-iteration",
    expression: "chunks",
    reason: "Caller-owned destination iovecs; ring copies use captured natives.",
  },
  {
    file: "browser/worker.ts",
    scope: "bootstrap.output",
    rule: "mutable-getter",
    expression: "data.buffer",
    reason: "Output bytes supplied by guest-owned WASM memory, not process control memory.",
  },
  {
    file: "browser/worker.ts",
    scope: "bootstrap.write",
    rule: "mutable-getter",
    expression: "data.length",
    reason: "Guest terminal output bytes, not private process or filesystem state.",
  },
  {
    file: "browser/worker.ts",
    scope: "bootstrap.post",
    rule: "mutable-getter",
    expression: "data.length",
    reason: "Guest stdout/stderr bytes, not a private process control buffer.",
  },
  {
    file: "browser/runtime-terminals.ts",
    scope: "createRuntimeTerminalCodec.import.write",
    rule: "mutable-builtin",
    expression: "chunks.reduce((size, bytes) => size + bytes.length, 0)",
    reason: "Guest terminal iovecs and numeric byte counting only.",
  },
  {
    file: "browser/runtime-terminals.ts",
    scope: "createRuntimeTerminalCodec.import.write",
    rule: "mutable-builtin",
    expression: "new Uint8Array(total)",
    reason: "Fresh outbound terminal payload; no private input to the constructor.",
  },
  {
    file: "browser/runtime-terminals.ts",
    scope: "createRuntimeTerminalCodec.import.write",
    rule: "private-iteration",
    expression: "chunks",
    reason: "Guest terminal iovecs, never private Stream provenance entries.",
  },
  {
    file: "browser/runtime-terminals.ts",
    scope: "createRuntimeTerminalCodec.import.write",
    rule: "mutable-builtin",
    expression: "data.set(bytes, offset)",
    reason: "Copy between terminal payload arrays, not provenance state.",
  },
  {
    file: "browser/runtime-terminals.ts",
    scope: "createRuntimeTerminalCodec.import.write",
    rule: "mutable-getter",
    expression: "bytes.length",
    reason: "Guest terminal payload byte length.",
  },
];

const payloadReturnScopes = new Set(["proc/abi.ts:ProcessABI.span", "proc/abi.ts:ProcessABI.view"]);
export const enforcedModules = [
  "proc/intrinsics.ts",
  "proc/intrinsics/core.ts",
  "proc/intrinsics/host.ts",
  "proc/errors.ts",
  "browser/worker.ts",
  "browser/worker-memory.ts",
  "browser/guarded-stream.ts",
  "browser/runtime-terminals.ts",
  "browser/terminal-session.ts",
  "browser/terminal-input.ts",
  "browser/terminal-lifetime.ts",
  "core/descriptors.ts",
  "proc/abi.ts",
  "proc/access.ts",
  "proc/admission.ts",
  "proc/control.ts",
  "proc/directory.ts",
  "proc/filesystem-codec.ts",
  "proc/identity.ts",
  "proc/outcome.ts",
  "proc/pipes.ts",
  "proc/signals.ts",
  "proc/terminal-lifetime.ts",
  "proc/terminal-turn.ts",
  "proc/start-errno.ts",
  "proc/start-failure.ts",
  "proc/types.ts",
  "proc/wait-status.ts",
  "proc/worker-access.ts",
  "proc/worker-client.ts",
  "proc/worker-pipes.ts",
];

const roots = ["browser/worker.ts", "proc/worker-client.ts", "proc/worker-pipes.ts"];
const views = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "DataView",
]);
const containers = new Set([
  "Array",
  "ReadonlyArray",
  "Map",
  "ReadonlyMap",
  "Set",
  "ReadonlySet",
  "WeakMap",
  "WeakSet",
]);
const authority = new Set([
  "SharedArrayBuffer",
  "TaggedCells",
  "OutcomeCell",
  "ControlCells",
  "OutcomeWord",
  "Descriptor",
  "DescriptorTable",
  "Resource",
  "Stream",
  "OpenDescription",
  "OpenFileDescription",
  "WorkerProcessTransport",
  "WorkerProcessClient",
  "WorkerProcessMessage",
  "WorkerDescriptorCodec",
  "WorkerAccessRequest",
  "PipeEndpoint",
  "PipeController",
  "PipePublicationRegistry",
  "Ring",
  "PipeEndpointHandle",
  "PipePublicationRegistryHandle",
  "FilesystemConnection",
  "FilesystemIdentity",
  "FilesystemReservation",
  "FilesystemCompletion",
  "FilesystemClient",
  "FilesystemSection",
  "SharedFilesystemState",
  "TerminalIdentity",
  "TerminalContext",
  "TerminalInput",
  "TerminalPolicy",
  "TerminalTurn",
  "TerminalAuthority",
  "TerminalAttachment",
  "TerminalProcessLifetime",
]);
const nativeOwners = new Set([
  "ObjectConstructor",
  "Reflect",
  "Atomics",
  "ArrayConstructor",
  "ArrayBufferConstructor",
  "SharedArrayBufferConstructor",
  "ProxyConstructor",
  "Function",
  "CallableFunction",
  "NewableFunction",
]);
const getters = new Set([
  "buffer",
  "byteLength",
  "byteOffset",
  "length",
  "size",
  "maxByteLength",
  "growable",
]);
const mutableMethods = new Set([
  "at",
  "copyWithin",
  "entries",
  "every",
  "fill",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "map",
  "reduce",
  "reduceRight",
  "reverse",
  "set",
  "slice",
  "some",
  "sort",
  "subarray",
  "toLocaleString",
  "toReversed",
  "toSorted",
  "toString",
  "values",
  "with",
  "get",
  "has",
  "add",
  "delete",
  "clear",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "concat",
  "flat",
  "flatMap",
  "getInt8",
  "getInt16",
  "getInt32",
  "getUint8",
  "getUint16",
  "getUint32",
  "getBigInt64",
  "getBigUint64",
  "getFloat32",
  "getFloat64",
  "setInt8",
  "setInt16",
  "setInt32",
  "setUint8",
  "setUint16",
  "setUint32",
  "setBigInt64",
  "setBigUint64",
  "setFloat32",
  "setFloat64",
  "grow",
]);

function scopeOf(node: ast.Node): string {
  const names: string[] = [];
  for (let parent: ast.Node | undefined = node; parent; parent = parent.parent) {
    if (
      ast.isFunctionDeclaration(parent) ||
      ast.isMethodDeclaration(parent) ||
      ast.isClassDeclaration(parent) ||
      ast.isGetAccessorDeclaration(parent) ||
      ast.isSetAccessorDeclaration(parent)
    ) {
      if (parent.name) names.unshift(parent.name.getText());
    } else if (
      ast.isVariableDeclaration(parent) &&
      parent.initializer &&
      (ast.isArrowFunction(parent.initializer) || ast.isFunctionExpression(parent.initializer))
    ) {
      names.unshift(parent.name.getText());
    }
  }
  return names.join(".") || "<module>";
}

function member(node: ast.Node): { receiver: ast.Expression; name: string } | undefined {
  if (ast.isPropertyAccessExpression(node))
    return { receiver: node.expression, name: node.name.text };
  if (ast.isElementAccessExpression(node) && node.argumentExpression) {
    const key = node.argumentExpression;
    if (ast.isStringLiteral(key)) return { receiver: node.expression, name: key.text };
    if (key.getText() === "Symbol.species" || key.getText() === "Symbol.iterator")
      return { receiver: node.expression, name: key.getText() };
  }
  return undefined;
}

function runtimeImports(file: ast.SourceFile): string[] {
  const imports: string[] = [];
  function visit(node: ast.Node): void {
    if (
      ast.isImportDeclaration(node) &&
      node.importClause?.phaseModifier !== ast.SyntaxKind.TypeKeyword &&
      ast.isStringLiteral(node.moduleSpecifier)
    ) {
      const bindings = node.importClause?.namedBindings;
      if (
        !bindings ||
        !ast.isNamedImports(bindings) ||
        bindings.elements.some((binding) => !binding.isTypeOnly)
      )
        imports.push(node.moduleSpecifier.text);
    } else if (
      ast.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ast.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    } else if (
      ast.isCallExpression(node) &&
      node.expression.kind === ast.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ast.isStringLiteral(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    }
    node.forEachChild(visit);
  }
  visit(file);
  return imports;
}

/** Local AST inference deliberately does not ask the unstable compiler's semantic
 * API to serialize tuples. Types are propagated through annotations, aliases,
 * initializers, object fields and collection results instead. */
interface InferenceContext {
  declarations: Map<ast.Node, Map<string, ast.Node>>;
  namedTypes: Map<string, ast.Node>;
  members: Map<string, Map<string, ast.Node>>;
  memo: Map<ast.Node, Set<string>>;
  root: string;
}

function mergeNames(target: Set<string>, source: Set<string>): void {
  for (const name of source) target.add(name);
}

function addElementNames(target: Set<string>, source: Set<string>): void {
  if (source.has("#private")) target.add("#private");
  for (const name of source) if (!name.startsWith("#")) target.add(`#element:${name}`);
}

function elementTypes(source: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const name of source) if (name.startsWith("#element:")) result.add(name.slice(9));
  if (source.has("#private")) result.add("#private");
  return result;
}

function recordClassMembers(
  node: ast.ClassDeclaration | ast.InterfaceDeclaration,
  members: Map<string, Map<string, ast.Node>>,
): void {
  if (!node.name) return;
  const properties = new Map<string, ast.Node>();
  for (const item of node.members) {
    if (isMemberDeclaration(item)) properties.set(item.name.getText(), item);
    if (!ast.isConstructorDeclaration(item)) continue;
    for (const param of item.parameters)
      if (ast.isIdentifier(param.name) && param.modifiers?.length)
        properties.set(param.name.text, param);
  }
  members.set(node.name.text, properties);
}

function isMemberDeclaration(
  node: ast.Node,
): node is
  | ast.PropertyDeclaration
  | ast.PropertySignatureDeclaration
  | ast.MethodDeclaration
  | ast.MethodSignatureDeclaration
  | ast.GetAccessorDeclaration
  | ast.SetAccessorDeclaration {
  return (
    ast.isPropertyDeclaration(node) ||
    ast.isPropertySignatureDeclaration(node) ||
    ast.isMethodDeclaration(node) ||
    ast.isMethodSignatureDeclaration(node) ||
    ast.isGetAccessorDeclaration(node) ||
    ast.isSetAccessorDeclaration(node)
  );
}

function lookupInference(
  context: InferenceContext,
  node: ast.Node,
  name: string,
): ast.Node | undefined {
  for (let scope: ast.Node | undefined = node; scope; scope = scope.parent) {
    const found = context.declarations.get(scope)?.get(name);
    if (found) return found;
  }
  return context.namedTypes.get(name);
}

function typeNames(
  context: InferenceContext,
  node: ast.Node | undefined,
  seen: Set<ast.Node>,
): Set<string> {
  const result = new Set<string>();
  if (!node) return result;
  if (ast.isTypeReferenceNode(node)) {
    if (["WebAssembly.Imports", "WebAssembly.ModuleImports"].includes(node.typeName.getText()))
      result.add("#private");
    mergeNames(result, typeNames(context, node.typeName, seen));
    for (const argument of node.typeArguments ?? [])
      addElementNames(result, typeNames(context, argument, new Set(seen)));
    return result;
  }
  if (ast.isIdentifier(node)) {
    result.add(node.text);
    if (authority.has(node.text) || views.has(node.text)) result.add("#private");
    const declared = context.namedTypes.get(node.text);
    if (declared && ast.isTypeAliasDeclaration(declared) && !seen.has(declared)) {
      seen.add(declared);
      mergeNames(result, typeNames(context, declared.type, seen));
    }
    return result;
  }
  if (ast.isArrayTypeNode(node) || ast.isTupleTypeNode(node)) {
    result.add("Array");
    node.forEachChild((child) => addElementNames(result, typeNames(context, child, new Set(seen))));
    return result;
  }
  if (ast.isFunctionTypeNode(node)) {
    result.add("Function");
    result.add("#private");
    return result;
  }
  if (ast.isTypeLiteralNode(node)) {
    node.forEachChild((child) => {
      if (typeNames(context, child, new Set(seen)).has("#private")) result.add("#private");
    });
    return result;
  }
  node.forEachChild((child) => mergeNames(result, typeNames(context, child, seen)));
  return result;
}

function inferVariable(
  context: InferenceContext,
  node:
    | ast.VariableDeclaration
    | ast.ParameterDeclaration
    | ast.PropertyDeclaration
    | ast.PropertySignatureDeclaration,
  seen: Set<ast.Node>,
): Set<string> {
  if (node.type) return typeNames(context, node.type, new Set());
  if ("initializer" in node && node.initializer) return inferNode(context, node.initializer, seen);
  if (
    ast.isVariableDeclaration(node) &&
    ast.isVariableDeclarationList(node.parent) &&
    ast.isForOfStatement(node.parent.parent)
  )
    return elementTypes(inferNode(context, node.parent.parent.expression, seen));
  return new Set();
}

function inferImport(context: InferenceContext, node: ast.ImportSpecifier): Set<string> {
  const result = new Set([(node.propertyName ?? node.name).text]);
  const declaration = node.parent.parent.parent;
  if (!ast.isImportDeclaration(declaration)) return result;
  const specifier = declaration.moduleSpecifier.getText().slice(1, -1);
  const path = relative(
    context.root,
    resolve(dirname(node.getSourceFile().fileName), specifier).replace(/\.js$/, ".ts"),
  );
  if (specifier.startsWith(".") && Object.hasOwn(intrinsicModules, path)) result.add("#captured");
  return result;
}

function inferThis(node: ast.Node): Set<string> {
  const result = new Set<string>();
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!ast.isClassDeclaration(parent) || !parent.name) continue;
    result.add(parent.name.text);
    break;
  }
  return result;
}

function inferNew(
  context: InferenceContext,
  node: ast.NewExpression,
  seen: Set<ast.Node>,
): Set<string> {
  const result = new Set<string>();
  const candidates = inferNode(context, node.expression, new Set(seen));
  const constructor = Array.from(candidates).find(
    (name) =>
      views.has(name.replace(/Constructor$/, "")) ||
      containers.has(name.replace(/Constructor$/, "")) ||
      name === "SharedArrayBufferConstructor",
  );
  const name = (constructor ?? node.expression.getText()).replace(/Constructor$/, "");
  result.add(name);
  if (views.has(name) || authority.has(name)) result.add("#private");
  for (const type of node.typeArguments ?? [])
    addElementNames(result, typeNames(context, type, new Set()));
  for (const argument of node.arguments ?? []) {
    if (inferNode(context, argument, new Set(seen)).has("#private")) result.add("#private");
  }
  return result;
}

function inferArrayLiteral(
  context: InferenceContext,
  node: ast.ArrayLiteralExpression,
  seen: Set<ast.Node>,
): Set<string> {
  const result = new Set(["Array"]);
  for (const element of node.elements)
    addElementNames(result, inferNode(context, element, new Set(seen)));
  return result;
}

function inferObjectLiteral(
  context: InferenceContext,
  node: ast.ObjectLiteralExpression,
  seen: Set<ast.Node>,
): Set<string> {
  const result = new Set<string>();
  for (const property of node.properties) {
    if (ast.isPropertyAssignment(property))
      mergeNames(result, inferNode(context, property.initializer, new Set(seen)));
    if (ast.isShorthandPropertyAssignment(property))
      mergeNames(result, inferNode(context, property.name, new Set(seen)));
  }
  return result;
}

function inferFunctionCaptures(
  context: InferenceContext,
  node: ast.ArrowFunction | ast.FunctionExpression,
  seen: Set<ast.Node>,
): Set<string> {
  const result = new Set(["Function"]);
  function visit(child: ast.Node): void {
    if (ast.isIdentifier(child) || child.kind === ast.SyntaxKind.ThisKeyword) {
      const declared = ast.isIdentifier(child)
        ? lookupInference(context, child, child.text)
        : undefined;
      let local = false;
      for (let parent = declared; parent; parent = parent.parent) {
        if (parent !== node) continue;
        local = true;
        break;
      }
      if (!local && inferNode(context, child, new Set(seen)).has("#private"))
        result.add("#private");
    }
    child.forEachChild(visit);
  }
  node.body.forEachChild(visit);
  return result;
}

function inferFunction(
  context: InferenceContext,
  node: ast.FunctionDeclaration | ast.MethodDeclaration | ast.GetAccessorDeclaration,
  seen: Set<ast.Node>,
): Set<string> {
  const result = typeNames(context, node.type, new Set());
  if (node.type || !node.body) return result;
  function visit(child: ast.Node): void {
    if (ast.isReturnStatement(child))
      mergeNames(result, inferNode(context, child.expression, new Set(seen)));
    if (!ast.isFunctionLikeDeclaration(child)) child.forEachChild(visit);
  }
  node.body.forEachChild(visit);
  return result;
}

function inferCall(
  context: InferenceContext,
  node: ast.CallExpression,
  seen: Set<ast.Node>,
): Set<string> {
  const result = new Set<string>();
  const access = member(node.expression);
  if (access) {
    const receiver = inferNode(context, access.receiver, new Set(seen));
    for (const name of receiver) {
      const method = context.members.get(name)?.get(access.name);
      if (method) mergeNames(result, inferNode(context, method, new Set(seen)));
    }
    if (["slice", "subarray", "filter", "map", "concat", "splice"].includes(access.name))
      mergeNames(result, receiver);
    if (["get", "values", "entries", "keys"].includes(access.name))
      mergeNames(result, elementTypes(receiver));
    return result;
  }
  if (!ast.isIdentifier(node.expression)) return result;
  const declared = lookupInference(context, node.expression, node.expression.text);
  if (declared) mergeNames(result, inferNode(context, declared, seen));
  const names = new Set(result);
  mergeNames(names, inferNode(context, node.expression, new Set(seen)));
  if (names.has("typedArraySubarray") || names.has("arrayFrom"))
    mergeNames(result, inferNode(context, node.arguments[0], seen));
  if (names.has("objectEntries") || names.has("objectValues")) {
    result.add("Array");
    addElementNames(result, inferNode(context, node.arguments[0], seen));
  }
  if (names.has("mapGet"))
    mergeNames(result, elementTypes(inferNode(context, node.arguments[0], seen)));
  if (names.has("typedArrayBuffer")) {
    result.add("SharedArrayBuffer");
    result.add("#private");
  }
  return result;
}

function inferMember(context: InferenceContext, node: ast.Node, seen: Set<ast.Node>): Set<string> {
  const result = new Set<string>();
  const access = member(node);
  if (!access)
    return ast.isElementAccessExpression(node)
      ? elementTypes(inferNode(context, node.expression, new Set(seen)))
      : result;
  const receiver = inferNode(context, access.receiver, new Set(seen));
  for (const name of receiver) {
    const property = context.members.get(name)?.get(access.name);
    if (property) inferMemberProperty(context, result, receiver, property, seen);
    inferTypeAliasMember(context, result, name, access.name, seen);
  }
  applySpecialMemberRules(result, receiver, access.name, node);
  return result;
}

function inferMemberProperty(
  context: InferenceContext,
  result: Set<string>,
  receiver: Set<string>,
  property: ast.Node,
  seen: Set<ast.Node>,
): void {
  if (ast.isMethodSignatureDeclaration(property) || ast.isMethodDeclaration(property)) {
    result.add("Function");
    if (receiver.has("#private")) result.add("#private");
    return;
  }
  mergeNames(result, inferNode(context, property, new Set(seen)));
}

function inferTypeAliasMember(
  context: InferenceContext,
  result: Set<string>,
  name: string,
  memberName: string,
  seen: Set<ast.Node>,
): void {
  const declaration = context.namedTypes.get(name);
  if (
    !declaration ||
    !ast.isTypeAliasDeclaration(declaration) ||
    !ast.isTypeLiteralNode(declaration.type)
  )
    return;
  for (const field of declaration.type.members) {
    if (ast.isPropertySignatureDeclaration(field) && field.name.getText() === memberName)
      mergeNames(result, inferNode(context, field, new Set(seen)));
  }
}

function applySpecialMemberRules(
  result: Set<string>,
  receiver: Set<string>,
  name: string,
  node: ast.Node,
): void {
  if (name === "buffer" && Array.from(receiver).some((entry) => views.has(entry))) {
    result.add("SharedArrayBuffer");
    result.add("#private");
  }
  if (
    name === "prototype" &&
    Array.from(receiver).some(
      (entry) => views.has(entry) || containers.has(entry) || entry === "Function",
    )
  ) {
    mergeNames(result, receiver);
    result.delete("#private");
    result.add("#prototype");
  } else if (
    mutableMethods.has(name) &&
    Array.from(receiver).some((entry) => views.has(entry) || containers.has(entry))
  ) {
    result.add("Function");
    if (receiver.has("#private")) result.add("#private");
  }
  if (
    Array.from(receiver).some((entry) => ["Object", "Reflect", "Atomics", "Array"].includes(entry))
  ) {
    result.add("#builtin");
    result.add("Function");
  }
  if (ast.isElementAccessExpression(node) && !ast.isStringLiteral(node.argumentExpression))
    mergeNames(result, elementTypes(receiver));
}

function inferComposite(
  context: InferenceContext,
  node: ast.Node,
  seen: Set<ast.Node>,
): Set<string> {
  if (ast.isAsExpression(node) || ast.isTypeAssertion(node)) {
    const result = typeNames(context, node.type, new Set());
    mergeNames(result, inferNode(context, node.expression, seen));
    return result;
  }
  if (
    ast.isParenthesizedExpression(node) ||
    ast.isNonNullExpression(node) ||
    ast.isAwaitExpression(node) ||
    ast.isSpreadElement(node)
  )
    return inferNode(context, node.expression, seen);
  if (ast.isConditionalExpression(node)) {
    const result = inferNode(context, node.whenTrue, new Set(seen));
    mergeNames(result, inferNode(context, node.whenFalse, new Set(seen)));
    return result;
  }
  if (ast.isBinaryExpression(node)) {
    const result = inferNode(context, node.left, new Set(seen));
    mergeNames(result, inferNode(context, node.right, new Set(seen)));
    return result;
  }
  if (ast.isArrowFunction(node) || ast.isFunctionExpression(node))
    return inferFunctionCaptures(context, node, seen);
  if (
    ast.isFunctionDeclaration(node) ||
    ast.isMethodDeclaration(node) ||
    ast.isGetAccessorDeclaration(node)
  )
    return inferFunction(context, node, seen);
  if (ast.isCallExpression(node)) return inferCall(context, node, seen);
  return inferMember(context, node, seen);
}

function inferNode(
  context: InferenceContext,
  node: ast.Node | undefined,
  seen = new Set<ast.Node>(),
): Set<string> {
  if (!node || seen.has(node)) return new Set();
  const known = context.memo.get(node);
  if (known) return known;
  seen.add(node);
  let result: Set<string>;
  if (
    ast.isVariableDeclaration(node) ||
    ast.isParameterDeclaration(node) ||
    ast.isPropertyDeclaration(node) ||
    ast.isPropertySignatureDeclaration(node)
  )
    result = inferVariable(context, node, seen);
  else if (ast.isImportSpecifier(node)) result = inferImport(context, node);
  else if (ast.isIdentifier(node)) {
    const declared = lookupInference(context, node, node.text);
    result =
      declared && ast.isFunctionDeclaration(declared)
        ? new Set(["Function"])
        : declared
          ? inferNode(context, declared, seen)
          : new Set([node.text]);
  } else if (node.kind === ast.SyntaxKind.ThisKeyword) result = inferThis(node);
  else if (ast.isNewExpression(node)) result = inferNew(context, node, seen);
  else if (ast.isArrayLiteralExpression(node)) result = inferArrayLiteral(context, node, seen);
  else if (ast.isObjectLiteralExpression(node)) result = inferObjectLiteral(context, node, seen);
  else result = inferComposite(context, node, seen);
  return finalizeInference(context, node, result);
}

function finalizeInference(
  context: InferenceContext,
  node: ast.Node,
  result: Set<string>,
): Set<string> {
  const key = `${relative(context.root, node.getSourceFile().fileName)}:${scopeOf(node)}`;
  if (
    (ast.isMethodDeclaration(node) || ast.isFunctionDeclaration(node)) &&
    payloadReturnScopes.has(key)
  ) {
    result.delete("#private");
    result.add("#payload");
  }
  if (
    !result.has("#payload") &&
    Array.from(result).some((name) => authority.has(name) || views.has(name))
  )
    result.add("#private");
  context.memo.set(node, result);
  return result;
}

function inference(files: readonly ast.SourceFile[], root: string) {
  const context: InferenceContext = {
    declarations: new Map(),
    namedTypes: new Map(),
    members: new Map(),
    memo: new Map(),
    root,
  };
  function lexicalScope(node: ast.Node): ast.Node {
    let parent = node.parent;
    while (
      parent.parent &&
      !ast.isSourceFile(parent) &&
      !ast.isBlock(parent) &&
      !ast.isFunctionLikeDeclaration(parent)
    )
      parent = parent.parent;
    return parent;
  }
  function record(scope: ast.Node, name: string, node: ast.Node): void {
    let entries = context.declarations.get(scope);
    if (!entries) context.declarations.set(scope, (entries = new Map()));
    entries.set(name, node);
  }
  function collect(node: ast.Node): void {
    if ((ast.isClassDeclaration(node) || ast.isInterfaceDeclaration(node)) && node.name)
      recordClassMembers(node, context.members);
    if (
      (ast.isClassDeclaration(node) ||
        ast.isInterfaceDeclaration(node) ||
        ast.isTypeAliasDeclaration(node)) &&
      node.name
    )
      context.namedTypes.set(node.name.text, node);
    if (
      (ast.isVariableDeclaration(node) || ast.isParameterDeclaration(node)) &&
      ast.isIdentifier(node.name)
    )
      record(lexicalScope(node), node.name.text, node);
    if (ast.isFunctionDeclaration(node) && node.name)
      record(lexicalScope(node), node.name.text, node);
    if (ast.isImportSpecifier(node)) record(lexicalScope(node), node.name.text, node);
    node.forEachChild(collect);
  }
  for (const file of files) collect(file);
  return {
    infer: (node: ast.Node | undefined, seen?: Set<ast.Node>) => inferNode(context, node, seen),
    declaration: (node: ast.Node, name: string) => lookupInference(context, node, name),
    isPrivate: (node: ast.Node) => inferNode(context, node).has("#private"),
  };
}
type AuthorityFiles = Map<string, { project: Project; file: ast.SourceFile }>;

async function loadReachableFiles(project: Project, root: string): Promise<AuthorityFiles> {
  const files: AuthorityFiles = new Map();
  const pending = Array.from(roots, (file) => resolve(root, file));
  while (pending.length) {
    const path = pending.pop()!;
    if (isSkippedAuthorityPath(files, root, path)) continue;
    const file = await project.program.getSourceFile(path);
    if (!file) throw new Error(`private-authority checker cannot inspect ${path}`);
    files.set(path, { project, file });
    pending.push(...resolveRuntimeDependencies(path, file));
  }
  return files;
}

function isSkippedAuthorityPath(files: AuthorityFiles, root: string, path: string): boolean {
  return (
    files.has(path) ||
    Boolean(
      trustedModules[relative(root, path)] &&
      !Object.hasOwn(intrinsicModules, relative(root, path)),
    )
  );
}

function resolveRuntimeDependencies(path: string, file: ast.SourceFile): string[] {
  const dependencies: string[] = [];
  for (const specifier of runtimeImports(file)) {
    if (!specifier.startsWith(".")) continue;
    const original = resolve(dirname(path), specifier);
    let dependency = original.replace(/\.js$/, ".ts");
    if (!existsSync(dependency))
      dependency = existsSync(original) ? original : resolve(dependency, "index.ts");
    dependencies.push(dependency);
  }
  return dependencies;
}

async function loadExtraFiles(
  snapshot: Awaited<ReturnType<API["updateSnapshot"]>>,
  root: string,
  extraFiles: readonly string[],
): Promise<AuthorityFiles> {
  const files: AuthorityFiles = new Map();
  for (const extra of extraFiles) {
    const path = resolve(root, extra);
    const owner = await snapshot.getDefaultProjectForFile(path);
    const file = await owner?.program.getSourceFile(path);
    if (!owner || !file)
      throw new Error(`private-authority checker cannot inspect fixture ${path}`);
    files.set(path, { project: owner, file });
  }
  return files;
}

function assertProcModulesClassified(root: string): void {
  for (const name of readdirSync(resolve(root, "proc"))) {
    const path = `proc/${name}`;
    if (!name.endsWith(".ts") || name === "index.ts") continue;
    if (enforcedModules.includes(path) || trustedModules[path]) continue;
    throw new Error(`classify new authority module ${path}`);
  }
}

function collectAuthorityFindings(
  files: AuthorityFiles,
  analysis: ReturnType<typeof inference>,
  root: string,
  extraFiles: readonly string[],
  auditDependencies: boolean,
): AuthorityFinding[] {
  const findings: AuthorityFinding[] = [];
  for (const { file } of files.values()) {
    const path = relative(root, file.fileName);
    if (!auditDependencies && !enforcedModules.includes(path) && !extraFiles.includes(path))
      continue;
    findings.push(...scanSource(analysis, file, path));
  }
  return findings;
}

export async function scanAuthorityProject(
  root: string,
  extraFiles: readonly string[] = [],
  auditDependencies = false,
): Promise<AuthorityFinding[]> {
  const api = new API({ cwd: root });
  try {
    const snapshot = await api.updateSnapshot({
      openProjects: [resolve(root, "tsconfig.json")],
      openFiles: Array.from(extraFiles, (file) => resolve(root, file)),
    });
    try {
      const project = snapshot.getProject(resolve(root, "tsconfig.json"));
      if (!project) throw new Error("private-authority checker could not load tsconfig.json");
      const files = await loadReachableFiles(project, root);
      const extras = await loadExtraFiles(snapshot, root, extraFiles);
      for (const [path, entry] of extras) files.set(path, entry);
      assertProcModulesClassified(root);
      const analysis = inference(
        Array.from(files.values(), (entry) => entry.file),
        root,
      );
      return collectAuthorityFindings(files, analysis, root, extraFiles, auditDependencies);
    } finally {
      await snapshot.dispose();
    }
  } finally {
    await api.close();
  }
}

function unwrap(node: ast.Node): ast.Node {
  if (ast.isAsExpression(node)) return unwrap(node.expression);
  if (ast.isTypeAssertion(node)) return unwrap(node.expression);
  if (ast.isParenthesizedExpression(node)) return unwrap(node.expression);
  if (ast.isNonNullExpression(node)) return unwrap(node.expression);
  return node;
}
function initializer(
  analysis: ReturnType<typeof inference>,
  node: ast.Node,
  seen = new Set<ast.Node>(),
): ast.Node {
  node = unwrap(node);
  if (seen.has(node)) return node;
  seen.add(node);
  if (!ast.isIdentifier(node)) return node;
  const declaration = analysis.declaration(node, node.text);
  if (declaration && ast.isVariableDeclaration(declaration) && declaration.initializer)
    return initializer(analysis, declaration.initializer, seen);
  return node;
}
function nativeName(
  analysis: ReturnType<typeof inference>,
  node: ast.Node,
  seen = new Set<ast.Node>(),
): string {
  node = unwrap(node);
  if (seen.has(node)) return "";
  seen.add(node);
  const access = member(node);
  if (access && ["Object", "Reflect"].includes(access.receiver.getText()))
    return `${access.receiver.getText()}.${access.name}`;
  if (!ast.isIdentifier(node)) return "";
  const declaration = analysis.declaration(node, node.text);
  if (declaration && ast.isVariableDeclaration(declaration) && declaration.initializer)
    return nativeName(analysis, declaration.initializer, seen);
  const name =
    declaration && ast.isImportSpecifier(declaration)
      ? (declaration.propertyName ?? declaration.name).text
      : node.text;
  return (
    (
      {
        objectCreate: "Object.create",
        objectDefineProperty: "Object.defineProperty",
        reflectDefineProperty: "Reflect.defineProperty",
        ProxyConstructor: "Proxy",
        SharedArrayBufferConstructor: "SharedArrayBuffer",
        ArrayBufferConstructor: "ArrayBuffer",
        arrayFrom: "Array.from",
      } as Record<string, string>
    )[name] ?? name
  );
}

function checkPropertyMap(
  analysis: ReturnType<typeof inference>,
  argument: ast.Node | undefined,
  check: (node: ast.Node | undefined) => void,
): void {
  check(argument);
  if (!argument) return;
  const map = initializer(analysis, argument);
  if (!ast.isObjectLiteralExpression(map)) return;
  for (const property of map.properties) {
    if (ast.isPropertyAssignment(property)) check(property.initializer);
  }
}

/** Native conversion can consult inherited hooks even through captured methods.
 * Check the capture module too: its call arguments are not a trusted boundary. */
function checkNativeConversions(
  analysis: ReturnType<typeof inference>,
  node: ast.Node,
  check: (node: ast.Node | undefined) => void,
): void {
  if (!ast.isCallExpression(node) && !ast.isNewExpression(node)) return;
  const name = nativeName(analysis, node.expression),
    args = node.arguments ?? [];
  if (["Object.defineProperty", "Reflect.defineProperty"].includes(name)) check(args[2]);
  if (["Object.create", "Object.defineProperties"].includes(name))
    checkPropertyMap(analysis, args[1], check);
  if (["Proxy", "SharedArrayBuffer", "ArrayBuffer"].includes(name)) check(args[1]);
  if (name === "Array.from") check(args[0]);
}

interface ScanContext {
  analysis: ReturnType<typeof inference>;
  path: string;
  report: (node: ast.Node, rule: AuthorityFinding["rule"]) => void;
}

function isPositiveWrapperTest(test: ast.Node, receiverText: string): boolean {
  return (
    ast.isCallExpression(test) &&
    test.expression.getText() === "isInstance" &&
    test.arguments[0]?.getText() === receiverText &&
    ["TaggedCells", "OutcomeCell"].includes(test.arguments[1]?.getText() ?? "")
  );
}

function isWrapperBranch(node: ast.Node, receiver: ast.Node): boolean {
  const receiverText = receiver.getText();
  let child = node;
  for (let parent = child.parent; parent; child = parent, parent = parent.parent) {
    if (
      ast.isConditionalExpression(parent) &&
      parent.whenTrue === child &&
      isPositiveWrapperTest(parent.condition, receiverText)
    )
      return true;
    if (
      ast.isIfStatement(parent) &&
      parent.thenStatement === child &&
      isPositiveWrapperTest(parent.expression, receiverText)
    )
      return true;
  }
  return false;
}

function isMutableGetterAccess(
  analysis: ReturnType<typeof inference>,
  node: ast.Node,
  access: { receiver: ast.Expression; name: string },
): boolean {
  if (!analysis.isPrivate(access.receiver) || isWrapperBranch(node, access.receiver)) return false;
  if (
    access.name === "constructor" ||
    access.name === "Symbol.species" ||
    access.name === "Symbol.iterator"
  )
    return false;
  if (!getters.has(access.name)) return false;
  const names = analysis.infer(access.receiver);
  return (
    Array.from(names).some((name) => views.has(name)) ||
    (["byteLength", "maxByteLength", "growable"].includes(access.name) &&
      names.has("SharedArrayBuffer")) ||
    (access.name === "size" && Array.from(names).some((name) => containers.has(name)))
  );
}

function scanAccess(
  node: ast.Node,
  access: { receiver: ast.Expression; name: string },
  context: ScanContext,
): void {
  if (!context.analysis.isPrivate(access.receiver)) return;
  if (
    access.name === "constructor" ||
    access.name === "Symbol.species" ||
    access.name === "Symbol.iterator"
  ) {
    context.report(node, "species");
    return;
  }
  if (isMutableGetterAccess(context.analysis, node, access)) context.report(node, "mutable-getter");
}

function hasPrivateArgument(
  node: ast.CallExpression | ast.NewExpression,
  analysis: ReturnType<typeof inference>,
): boolean {
  return Array.from(node.arguments ?? []).some((argument) => analysis.isPrivate(argument));
}

function isAuthorityGlobal(
  node: ast.CallExpression | ast.NewExpression,
  callee: { receiver: ast.Expression; name: string } | undefined,
  analysis: ReturnType<typeof inference>,
): boolean {
  const callText = node.expression.getText();
  return (
    [
      "setTimeout",
      "clearTimeout",
      "queueMicrotask",
      "structuredClone",
      "postMessage",
      "Date",
    ].includes(callText) ||
    /^(?:globalThis\.)?(?:crypto\.(?:randomUUID|getRandomValues)|performance\.now|Date\.now|setTimeout|clearTimeout|queueMicrotask|structuredClone|postMessage)$/.test(
      callText,
    ) ||
    (callee?.name === "postMessage" && analysis.infer(callee.receiver).has("RuntimeWorkerHost"))
  );
}

function isMutableBuiltinCall(
  node: ast.CallExpression | ast.NewExpression,
  callee: { receiver: ast.Expression; name: string } | undefined,
  analysis: ReturnType<typeof inference>,
): boolean {
  const privateArgument = hasPrivateArgument(node, analysis);
  if (!callee) {
    if (ast.isCallExpression(node))
      return analysis.infer(node.expression).has("#builtin") && privateArgument;
    const names = analysis.infer(node.expression);
    return (
      !names.has("#captured") &&
      Array.from(names).some(
        (name) =>
          views.has(name) ||
          name === "SharedArrayBuffer" ||
          name === "Proxy" ||
          containers.has(name),
      ) &&
      (privateArgument || analysis.isPrivate(node))
    );
  }
  const receiverNames = analysis.infer(callee.receiver);
  const nativeReceiver = Array.from(receiverNames).some(
    (name) => views.has(name) || containers.has(name) || name === "SharedArrayBuffer",
  );
  const nativeMutation =
    nativeReceiver &&
    !isWrapperBranch(node, callee.receiver) &&
    mutableMethods.has(callee.name) &&
    (analysis.isPrivate(callee.receiver) || privateArgument);
  const nativeOwner =
    Array.from(receiverNames).some(
      (name) =>
        nativeOwners.has(name) || ["Object", "Reflect", "Atomics", "Array", "Proxy"].includes(name),
    ) && privateArgument;
  const functionCall =
    ["call", "apply", "bind"].includes(callee.name) &&
    receiverNames.has("Function") &&
    (analysis.isPrivate(callee.receiver) || privateArgument);
  return nativeMutation || nativeOwner || functionCall;
}

function scanCall(node: ast.CallExpression | ast.NewExpression, context: ScanContext): void {
  const callee = member(node.expression);
  if (isAuthorityGlobal(node, callee, context.analysis)) context.report(node, "authority-global");
  if (isMutableBuiltinCall(node, callee, context.analysis)) context.report(node, "mutable-builtin");
}

function arrayBindingSource(pattern: ast.ArrayBindingPattern): ast.Node | undefined {
  for (let owner: ast.Node | undefined = pattern.parent; owner; owner = owner.parent) {
    if (ast.isVariableDeclaration(owner)) return owner.initializer ?? owner;
    if (ast.isParameterDeclaration(owner)) return owner;
    if (
      !ast.isBindingElement(owner) &&
      !ast.isArrayBindingPattern(owner) &&
      !ast.isObjectBindingPattern(owner)
    )
      return;
  }
  return undefined;
}

function scanNode(node: ast.Node, context: ScanContext): void {
  checkNativeConversions(context.analysis, node, (argument) => {
    const literal = argument && initializer(context.analysis, argument);
    if (!literal || !ast.isObjectLiteralExpression(literal)) return;
    const hasNullPrototype = literal.properties.some(
      (property) =>
        ast.isPropertyAssignment(property) &&
        property.name.getText() === "__proto__" &&
        property.initializer.kind === ast.SyntaxKind.NullKeyword,
    );
    if (!hasNullPrototype) context.report(literal, "native-conversion");
  });
  if (Object.hasOwn(intrinsicModules, context.path)) return;
  if (context.path === "proc/worker-pipes.ts" && scopeOf(node).split(".")[0] === "WorkerPipeBroker")
    return;
  if (ast.isArrayBindingPattern(node)) {
    const source = arrayBindingSource(node);
    if (source && context.analysis.isPrivate(source)) context.report(node, "private-iteration");
    return;
  }
  if (ast.isForOfStatement(node) || ast.isSpreadElement(node)) {
    if (context.analysis.isPrivate(node.expression))
      context.report(node.expression, "private-iteration");
    return;
  }
  const access = member(node);
  if (access) scanAccess(node, access, context);
  if (!ast.isCallExpression(node) && !ast.isNewExpression(node)) return;
  scanCall(node, context);
}

function scanSource(
  analysis: ReturnType<typeof inference>,
  file: ast.SourceFile,
  path: string,
): AuthorityFinding[] {
  const nodes: ast.Node[] = [];
  function visit(node: ast.Node): void {
    if (
      ast.isCallExpression(node) ||
      ast.isNewExpression(node) ||
      member(node) ||
      ast.isForOfStatement(node) ||
      ast.isArrayBindingPattern(node) ||
      ast.isSpreadElement(node)
    )
      nodes.push(node);
    node.forEachChild(visit);
  }
  visit(file);
  const findings: AuthorityFinding[] = [];
  const report = (node: ast.Node, rule: AuthorityFinding["rule"]): void => {
    const finding: AuthorityFinding = {
      file: path,
      line: file.text.slice(0, node.getStart()).split("\n").length,
      scope: scopeOf(node),
      rule,
      expression: node.getText(),
    };
    if (
      !payloadExceptions.some(
        (entry) =>
          entry.file === path &&
          entry.scope === finding.scope &&
          entry.rule === rule &&
          entry.expression === finding.expression,
      )
    )
      findings.push(finding);
  };
  const context: ScanContext = { analysis, path, report };
  for (const node of nodes) scanNode(node, context);
  return findings;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const findings = await scanAuthorityProject(root, [], Bun.argv.includes("--audit-dependencies"));
  for (const finding of findings)
    console.error(
      `${finding.file}:${finding.line} ${finding.rule} [${finding.scope}] ${finding.expression.replace(/\s+/g, " ").slice(0, 220)}`,
    );
  console.log(`${findings.length} private-authority boundary findings`);
  if (findings.length) process.exitCode = 1;
}
