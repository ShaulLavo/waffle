import { existsSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { API, type Project } from "typescript/unstable/async";
import * as ast from "typescript/unstable/ast";

/** Same-realm guest code can replace builtins after Worker initialization. */
export interface AuthorityFinding {
  file: string;
  line: number;
  scope: string;
  rule: "mutable-builtin" | "mutable-getter" | "private-iteration" | "species" | "native-conversion" | "authority-global";
  expression: string;
}

// These implementations run in the trusted page/service realm, never in the
// guest Worker. Barrels may re-export them; that does not make their methods
// guest-reachable. New modules are NOT implicitly excluded.
export const trustedModules: Readonly<Record<string, string>> = {
  "proc/intrinsics.ts": "Initialization-time native captures; review changes to this trust root manually.",
  "proc/supervisor.ts": "Page-owned supervisor, not imported by the guest bootstrap.",
  "proc/table.ts": "Page-owned process table, not imported by the guest bootstrap.",
  "proc/registry.ts": "Page-owned process registry, not imported by the guest bootstrap.",
  "proc/stub.ts": "Page-only lazy process facade, not a guest Worker implementation.",
  "proc/worker-broker.ts": "Page-owned message broker, not imported by the guest bootstrap.",
  "fs/service.ts": "Filesystem service runs in its dedicated trusted Worker, not the guest realm.",
  "fs/backend.ts": "Backend used by the dedicated filesystem service.",
  "fs/persistent.ts": "Persistence backend used by the dedicated filesystem service.",
  "fs/indexeddb.ts": "Storage backend used by the dedicated filesystem service.",
  "fs/opfs.ts": "Storage backend used by the dedicated filesystem service.",
  "fs/storage.ts": "Storage interface for the dedicated filesystem service.",
  "core/memory-views.js": "Guest-owned WebAssembly memory view helpers; no private runtime buffers.",
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
  { file: "proc/pipes.ts", scope: "length", rule: "mutable-builtin", expression: "chunks.reduce((total, chunk) => total + typedArrayLength(chunk), 0)", reason: "Caller-owned byte iovecs; no private ring, cursor or endpoint is an element or callback capture." },
  { file: "proc/pipes.ts", scope: "Ring.write", rule: "private-iteration", expression: "chunks", reason: "Caller-owned source iovecs; ring copies use captured natives." },
  { file: "proc/pipes.ts", scope: "Ring.read", rule: "private-iteration", expression: "chunks", reason: "Caller-owned destination iovecs; ring copies use captured natives." },
  { file: "browser/worker.ts", scope: "bootstrap.output", rule: "mutable-getter", expression: "data.buffer", reason: "Output bytes supplied by guest-owned WASM memory, not process control memory." },
  { file: "browser/worker.ts", scope: "bootstrap.write", rule: "mutable-getter", expression: "data.length", reason: "Guest terminal output bytes, not private process or filesystem state." },
  { file: "browser/worker.ts", scope: "bootstrap.post", rule: "mutable-getter", expression: "data.length", reason: "Guest stdout/stderr bytes, not a private process control buffer." },
  { file: "browser/runtime-terminals.ts", scope: "createRuntimeTerminalCodec.import.write", rule: "mutable-builtin", expression: "chunks.reduce((size, bytes) => size + bytes.length, 0)", reason: "Guest terminal iovecs and numeric byte counting only." },
  { file: "browser/runtime-terminals.ts", scope: "createRuntimeTerminalCodec.import.write", rule: "mutable-builtin", expression: "new Uint8Array(total)", reason: "Fresh outbound terminal payload; no private input to the constructor." },
  { file: "browser/runtime-terminals.ts", scope: "createRuntimeTerminalCodec.import.write", rule: "private-iteration", expression: "chunks", reason: "Guest terminal iovecs, never private Stream provenance entries." },
  { file: "browser/runtime-terminals.ts", scope: "createRuntimeTerminalCodec.import.write", rule: "mutable-builtin", expression: "data.set(bytes, offset)", reason: "Copy between terminal payload arrays, not provenance state." },
  { file: "browser/runtime-terminals.ts", scope: "createRuntimeTerminalCodec.import.write", rule: "mutable-getter", expression: "bytes.length", reason: "Guest terminal payload byte length." },
];

const payloadReturnScopes = new Set(["proc/abi.ts:ProcessABI.span", "proc/abi.ts:ProcessABI.view"]);
export const enforcedModules = [
  "proc/intrinsics.ts", "browser/worker.ts", "browser/guarded-stream.ts", "browser/runtime-terminals.ts", "core/descriptors.ts",
  "proc/abi.ts", "proc/access.ts", "proc/admission.ts", "proc/control.ts", "proc/directory.ts",
  "proc/filesystem-codec.ts", "proc/identity.ts", "proc/outcome.ts", "proc/pipes.ts", "proc/signals.ts",
  "proc/start-errno.ts", "proc/start-failure.ts", "proc/types.ts", "proc/wait-status.ts", "proc/worker-access.ts",
  "proc/worker-client.ts", "proc/worker-pipes.ts",
];

const roots = ["browser/worker.ts", "proc/worker-client.ts", "proc/worker-pipes.ts"];
const views = new Set(["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "DataView"]);
const containers = new Set(["Array", "ReadonlyArray", "Map", "ReadonlyMap", "Set", "ReadonlySet", "WeakMap", "WeakSet"]);
const authority = new Set([
  "SharedArrayBuffer", "TaggedCells", "OutcomeCell", "ControlCells", "OutcomeWord",
  "Descriptor", "DescriptorTable", "Resource", "Stream", "OpenDescription", "OpenFileDescription",
  "WorkerProcessTransport", "WorkerProcessClient", "WorkerProcessMessage", "WorkerDescriptorCodec",
  "WorkerAccessRequest", "PipeEndpoint", "PipeController", "PipePublicationRegistry", "Ring",
  "PipeEndpointHandle", "PipePublicationRegistryHandle", "FilesystemConnection", "FilesystemIdentity",
  "FilesystemReservation", "FilesystemCompletion", "FilesystemClient", "FilesystemSection", "SharedFilesystemState",
]);
const nativeOwners = new Set(["ObjectConstructor", "Reflect", "Atomics", "ArrayConstructor", "ArrayBufferConstructor", "SharedArrayBufferConstructor", "ProxyConstructor", "Function", "CallableFunction", "NewableFunction"]);
const getters = new Set(["buffer", "byteLength", "byteOffset", "length", "size", "maxByteLength", "growable"]);
const mutableMethods = new Set(["at", "copyWithin", "entries", "every", "fill", "filter", "find", "findIndex", "findLast", "findLastIndex", "forEach", "includes", "indexOf", "join", "keys", "lastIndexOf", "map", "reduce", "reduceRight", "reverse", "set", "slice", "some", "sort", "subarray", "toLocaleString", "toReversed", "toSorted", "toString", "values", "with", "get", "has", "add", "delete", "clear", "push", "pop", "shift", "unshift", "splice", "concat", "flat", "flatMap", "getInt8", "getInt16", "getInt32", "getUint8", "getUint16", "getUint32", "getBigInt64", "getBigUint64", "getFloat32", "getFloat64", "setInt8", "setInt16", "setInt32", "setUint8", "setUint16", "setUint32", "setBigInt64", "setBigUint64", "setFloat32", "setFloat64", "grow"]);

function scopeOf(node: ast.Node): string {
  const names: string[] = [];
  for (let parent: ast.Node | undefined = node; parent; parent = parent.parent) {
    if (ast.isFunctionDeclaration(parent) || ast.isMethodDeclaration(parent) || ast.isClassDeclaration(parent) || ast.isGetAccessorDeclaration(parent) || ast.isSetAccessorDeclaration(parent)) {
      if (parent.name) names.unshift(parent.name.getText());
    } else if (ast.isVariableDeclaration(parent) && parent.initializer && (ast.isArrowFunction(parent.initializer) || ast.isFunctionExpression(parent.initializer))) {
      names.unshift(parent.name.getText());
    }
  }
  return names.join(".") || "<module>";
}

function member(node: ast.Node): { receiver: ast.Expression; name: string } | undefined {
  if (ast.isPropertyAccessExpression(node)) return { receiver: node.expression, name: node.name.text };
  if (ast.isElementAccessExpression(node) && node.argumentExpression) {
    const key = node.argumentExpression;
    if (ast.isStringLiteral(key)) return { receiver: node.expression, name: key.text };
    if (key.getText() === "Symbol.species" || key.getText() === "Symbol.iterator") return { receiver: node.expression, name: key.getText() };
  }
  return undefined;
}

function runtimeImports(file: ast.SourceFile): string[] {
  const imports: string[] = [];
  function visit(node: ast.Node): void {
    if (ast.isImportDeclaration(node) && node.importClause?.phaseModifier !== ast.SyntaxKind.TypeKeyword && ast.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (!bindings || !ast.isNamedImports(bindings) || bindings.elements.some((binding) => !binding.isTypeOnly)) imports.push(node.moduleSpecifier.text);
    } else if (ast.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ast.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    } else if (ast.isCallExpression(node) && node.expression.kind === ast.SyntaxKind.ImportKeyword && node.arguments[0] && ast.isStringLiteral(node.arguments[0])) {
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
function inference(files: readonly ast.SourceFile[], root: string) {
  const declarations = new Map<ast.Node, Map<string, ast.Node>>();
  const namedTypes = new Map<string, ast.Node>();
  const members = new Map<string, Map<string, ast.Node>>();
  const memo = new Map<ast.Node, Set<string>>();
  const privateMark = "#private";
  function lexicalScope(node: ast.Node): ast.Node {
    let parent = node.parent;
    while (parent.parent && !ast.isSourceFile(parent) && !ast.isBlock(parent) && !ast.isFunctionLikeDeclaration(parent)) parent = parent.parent;
    return parent;
  }
  function record(scope: ast.Node, name: string, node: ast.Node): void {
    let entries = declarations.get(scope);
    if (!entries) declarations.set(scope, entries = new Map());
    entries.set(name, node);
  }
  function collect(node: ast.Node): void {
    if ((ast.isClassDeclaration(node) || ast.isInterfaceDeclaration(node) || ast.isTypeAliasDeclaration(node)) && node.name) namedTypes.set(node.name.text, node);
    if ((ast.isClassDeclaration(node) || ast.isInterfaceDeclaration(node)) && node.name) {
      const properties = new Map<string, ast.Node>();
      for (const item of node.members) if (ast.isPropertyDeclaration(item) || ast.isPropertySignatureDeclaration(item) || ast.isMethodDeclaration(item) || ast.isMethodSignatureDeclaration(item) || ast.isGetAccessorDeclaration(item) || ast.isSetAccessorDeclaration(item)) properties.set(item.name.getText(), item);
      // Constructor parameter properties are real fields, not just parameters.
      for (const item of node.members) if (ast.isConstructorDeclaration(item)) for (const param of item.parameters) if (ast.isIdentifier(param.name) && param.modifiers?.length) properties.set(param.name.text, param);
      members.set(node.name.text, properties);
    }
    if ((ast.isVariableDeclaration(node) || ast.isParameterDeclaration(node)) && ast.isIdentifier(node.name)) record(lexicalScope(node), node.name.text, node);
    if (ast.isFunctionDeclaration(node) && node.name) record(lexicalScope(node), node.name.text, node);
    if (ast.isImportSpecifier(node)) record(lexicalScope(node), node.name.text, node);
    node.forEachChild(collect);
  }
  for (const file of files) collect(file);
  function lookup(node: ast.Node, name: string): ast.Node | undefined {
    for (let scope: ast.Node | undefined = node; scope; scope = scope.parent) {
      const found = declarations.get(scope)?.get(name);
      if (found) return found;
    }
    return namedTypes.get(name);
  }
  function merge(target: Set<string>, source: Set<string>): void { for (const name of source) target.add(name); }
  function typeNames(node: ast.Node | undefined, seen: Set<ast.Node>): Set<string> {
    const result = new Set<string>();
    if (!node) return result;
    if (ast.isTypeReferenceNode(node)) {
      merge(result, typeNames(node.typeName, seen));
      for (const argument of node.typeArguments ?? []) {
        const nested = typeNames(argument, new Set(seen));
        if (nested.has(privateMark)) result.add(privateMark);
        for (const name of nested) if (!name.startsWith("#")) result.add(`#element:${name}`);
      }
    } else if (ast.isIdentifier(node)) {
      result.add(node.text);
      if (authority.has(node.text) || views.has(node.text)) result.add(privateMark);
      const declared = namedTypes.get(node.text);
      if (declared && ast.isTypeAliasDeclaration(declared) && !seen.has(declared)) { seen.add(declared); merge(result, typeNames(declared.type, seen)); }
    } else if (ast.isArrayTypeNode(node) || ast.isTupleTypeNode(node)) {
      result.add("Array");
      node.forEachChild((child) => {
        const nested = typeNames(child, new Set(seen));
        if (nested.has(privateMark)) result.add(privateMark);
        for (const name of nested) if (!name.startsWith("#")) result.add(`#element:${name}`);
      });
    } else if (ast.isFunctionTypeNode(node)) { result.add("Function"); result.add(privateMark); }
    else if (ast.isTypeLiteralNode(node)) {
      node.forEachChild((child) => { if (typeNames(child, new Set(seen)).has(privateMark)) result.add(privateMark); });
    } else node.forEachChild((child) => { merge(result, typeNames(child, seen)); });
    return result;
  }
  function elementTypes(source: Set<string>): Set<string> {
    const result = new Set<string>();
    for (const name of source) if (name.startsWith("#element:")) result.add(name.slice(9));
    if (source.has(privateMark)) result.add(privateMark);
    return result;
  }
  function infer(node: ast.Node | undefined, seen = new Set<ast.Node>()): Set<string> {
    if (!node || seen.has(node)) return new Set();
    const known = memo.get(node);
    if (known) return known;
    seen.add(node);
    let result = new Set<string>();
    if (ast.isVariableDeclaration(node) || ast.isParameterDeclaration(node) || ast.isPropertyDeclaration(node) || ast.isPropertySignatureDeclaration(node)) {
      result = node.type ? typeNames(node.type, new Set()) : infer(node.initializer, seen);
      if (!node.type && !node.initializer && ast.isVariableDeclaration(node) && ast.isVariableDeclarationList(node.parent) && ast.isForOfStatement(node.parent.parent)) result = elementTypes(infer(node.parent.parent.expression, seen));
    } else if (ast.isImportSpecifier(node)) {
      result.add((node.propertyName ?? node.name).text);
      const declaration = node.parent.parent.parent;
      if (ast.isImportDeclaration(declaration) && /(?:^|\/)intrinsics\.(?:ts|js)$/.test(declaration.moduleSpecifier.getText().slice(1, -1))) result.add("#captured");
    } else if (ast.isIdentifier(node)) {
      const declared = lookup(node, node.text);
      if (declared && ast.isFunctionDeclaration(declared)) result.add("Function");
      else if (declared) result = infer(declared, seen);
      else result.add(node.text);
    } else if (node.kind === ast.SyntaxKind.ThisKeyword) {
      for (let parent = node.parent; parent; parent = parent.parent) if (ast.isClassDeclaration(parent) && parent.name) { result.add(parent.name.text); break; }
    } else if (ast.isNewExpression(node)) {
      const candidates = infer(node.expression, new Set(seen));
      const constructor = Array.from(candidates).find((name) => views.has(name.replace(/Constructor$/, "")) || containers.has(name.replace(/Constructor$/, "")) || name === "SharedArrayBufferConstructor");
      const name = (constructor ?? node.expression.getText()).replace(/Constructor$/, "");
      result.add(name);
      if (views.has(name) || authority.has(name)) result.add(privateMark);
      for (const type of node.typeArguments ?? []) { const nested = typeNames(type, new Set()); if (nested.has(privateMark)) result.add(privateMark); for (const name of nested) if (!name.startsWith("#")) result.add(`#element:${name}`); }
      for (const argument of node.arguments ?? []) if (infer(argument, new Set(seen)).has(privateMark)) result.add(privateMark);
    } else if (ast.isArrayLiteralExpression(node)) {
      result.add("Array");
      for (const element of node.elements) { const nested = infer(element, new Set(seen)); if (nested.has(privateMark)) result.add(privateMark); for (const name of nested) if (!name.startsWith("#")) result.add(`#element:${name}`); }
    } else if (ast.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ast.isPropertyAssignment(property)) merge(result, infer(property.initializer, new Set(seen)));
        if (ast.isShorthandPropertyAssignment(property)) merge(result, infer(property.name, new Set(seen)));
      }
    } else if (ast.isAsExpression(node) || ast.isTypeAssertion(node)) {
      result = typeNames(node.type, new Set());
      merge(result, infer(node.expression, seen));
    } else if (ast.isParenthesizedExpression(node) || ast.isNonNullExpression(node) || ast.isAwaitExpression(node) || ast.isSpreadElement(node)) result = infer(node.expression, seen);
    else if (ast.isConditionalExpression(node)) { merge(result, infer(node.whenTrue, new Set(seen))); merge(result, infer(node.whenFalse, new Set(seen))); }
    else if (ast.isBinaryExpression(node)) { merge(result, infer(node.left, new Set(seen))); merge(result, infer(node.right, new Set(seen))); }
    else if (ast.isArrowFunction(node) || ast.isFunctionExpression(node)) {
      result.add("Function");
      function captures(child: ast.Node): void {
        if (ast.isIdentifier(child) || child.kind === ast.SyntaxKind.ThisKeyword) {
          const declared = ast.isIdentifier(child) ? lookup(child, child.text) : undefined;
          let local = false;
          for (let parent = declared; parent; parent = parent.parent) if (parent === node) { local = true; break; }
          if (!local && infer(child, new Set(seen)).has(privateMark)) result.add(privateMark);
        }
        child.forEachChild(captures);
      }
      node.body.forEachChild(captures);
    }
    else if (ast.isFunctionDeclaration(node) || ast.isMethodDeclaration(node) || ast.isGetAccessorDeclaration(node)) {
      result = typeNames(node.type, new Set());
      if (!node.type && node.body) {
        function returns(child: ast.Node): void {
          if (ast.isReturnStatement(child)) merge(result, infer(child.expression, new Set(seen)));
          else if (!ast.isFunctionLikeDeclaration(child)) child.forEachChild(returns);
        }
        node.body.forEachChild(returns);
      }
    } else if (ast.isCallExpression(node)) {
      const access = member(node.expression);
      if (access) {
        const receiver = infer(access.receiver, new Set(seen));
        for (const name of receiver) {
          const method = members.get(name)?.get(access.name);
          if (method) merge(result, infer(method, new Set(seen)));
        }
        if (["slice", "subarray", "filter", "map", "concat", "splice"].includes(access.name)) merge(result, receiver);
        if (["get", "values", "entries", "keys"].includes(access.name)) merge(result, elementTypes(receiver));
      } else if (ast.isIdentifier(node.expression)) {
        const declared = lookup(node.expression, node.expression.text);
        if (declared) merge(result, infer(declared, seen));
        const names = infer(node.expression, new Set(seen));
        if (names.has("typedArraySubarray") || names.has("arrayFrom")) merge(result, infer(node.arguments[0], seen));
        if (names.has("mapGet")) merge(result, elementTypes(infer(node.arguments[0], seen)));
        if (names.has("typedArrayBuffer")) { result.add("SharedArrayBuffer"); result.add(privateMark); }
      }
    } else {
      const access = member(node);
      if (access) {
        const receiver = infer(access.receiver, new Set(seen));
        for (const name of receiver) {
          const property = members.get(name)?.get(access.name);
          if (property) {
            if (ast.isMethodSignatureDeclaration(property) || ast.isMethodDeclaration(property)) { result.add("Function"); if (receiver.has(privateMark)) result.add(privateMark); }
            else merge(result, infer(property, new Set(seen)));
          }
          const declaration = namedTypes.get(name);
          if (declaration && ast.isTypeAliasDeclaration(declaration) && ast.isTypeLiteralNode(declaration.type)) {
            for (const field of declaration.type.members) if (ast.isPropertySignatureDeclaration(field) && field.name.getText() === access.name) merge(result, infer(field, new Set(seen)));
          }
        }
        if (access.name === "buffer" && Array.from(receiver).some((name) => views.has(name))) { result.add("SharedArrayBuffer"); result.add(privateMark); }
        if (access.name === "prototype" && Array.from(receiver).some((name) => views.has(name) || containers.has(name) || name === "Function")) {
          merge(result, receiver); result.delete(privateMark); result.add("#prototype");
        } else if (mutableMethods.has(access.name) && Array.from(receiver).some((name) => views.has(name) || containers.has(name))) {
          result.add("Function");
          if (receiver.has(privateMark)) result.add(privateMark);
        }
        if (Array.from(receiver).some((name) => ["Object", "Reflect", "Atomics", "Array"].includes(name))) { result.add("#builtin"); result.add("Function"); }
        // Array indexing retains the element's inferred authority.
        if (ast.isElementAccessExpression(node) && !ast.isStringLiteral(node.argumentExpression)) merge(result, elementTypes(receiver));
      }
    }
    const key = `${relative(root, node.getSourceFile().fileName)}:${scopeOf(node)}`;
    if ((ast.isMethodDeclaration(node) || ast.isFunctionDeclaration(node)) && payloadReturnScopes.has(key)) { result.delete(privateMark); result.add("#payload"); }
    if (!result.has("#payload") && Array.from(result).some((name) => authority.has(name) || views.has(name))) result.add(privateMark);
    memo.set(node, result);
    return result;
  }
  return { infer, declaration: lookup, isPrivate: (node: ast.Node) => infer(node).has(privateMark) };
}

export async function scanAuthorityProject(root: string, extraFiles: readonly string[] = [], auditDependencies = false): Promise<AuthorityFinding[]> {
  const api = new API({ cwd: root });
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [resolve(root, "tsconfig.json")], openFiles: Array.from(extraFiles, (file) => resolve(root, file)) });
    try {
      const project = snapshot.getProject(resolve(root, "tsconfig.json"));
      if (!project) throw new Error("private-authority checker could not load tsconfig.json");
      const files = new Map<string, { project: Project; file: ast.SourceFile }>();
      const pending = Array.from(roots, (file) => resolve(root, file));
      while (pending.length) {
        const path = pending.pop()!;
        if (files.has(path) || (trustedModules[relative(root, path)] && relative(root, path) !== "proc/intrinsics.ts")) continue;
        const file = await project.program.getSourceFile(path);
        if (!file) throw new Error(`private-authority checker cannot inspect ${path}`);
        files.set(path, { project, file });
        for (const specifier of runtimeImports(file)) {
          if (!specifier.startsWith(".")) continue;
          const original = resolve(dirname(path), specifier);
          let dependency = original.replace(/\.js$/, ".ts");
          if (!existsSync(dependency)) dependency = existsSync(original) ? original : resolve(dependency, "index.ts");
          pending.push(dependency);
        }
      }
      for (const extra of extraFiles) {
        const path = resolve(root, extra);
        const owner = await snapshot.getDefaultProjectForFile(path);
        const file = await owner?.program.getSourceFile(path);
        if (!owner || !file) throw new Error(`private-authority checker cannot inspect fixture ${path}`);
        files.set(path, { project: owner, file });
      }
      // New proc implementation modules must be assigned a reviewed boundary,
      // rather than silently escaping an old fixed list.
      for (const name of readdirSync(resolve(root, "proc"))) {
        const path = `proc/${name}`;
        if (name.endsWith(".ts") && name !== "index.ts" && !enforcedModules.includes(path) && !trustedModules[path]) throw new Error(`classify new authority module ${path}`);
      }
      const analysis = inference(Array.from(files.values(), (entry) => entry.file), root);
      const findings: AuthorityFinding[] = [];
      for (const { file } of files.values()) {
        const path = relative(root, file.fileName);
        if (!auditDependencies && !enforcedModules.includes(path) && !extraFiles.includes(path)) continue;
        findings.push(...scanSource(analysis, file, path));
      }
      return findings;
    } finally { await snapshot.dispose(); }
  } finally { await api.close(); }
}

function unwrap(node: ast.Node): ast.Node {
  while (ast.isAsExpression(node) || node.kind === ast.SyntaxKind.TypeAssertionExpression || ast.isParenthesizedExpression(node) || ast.isNonNullExpression(node)) node = node.expression;
  return node;
}
function initializer(analysis: ReturnType<typeof inference>, node: ast.Node, seen = new Set<ast.Node>()): ast.Node {
  node = unwrap(node);
  if (seen.has(node)) return node;
  seen.add(node);
  if (!ast.isIdentifier(node)) return node;
  const declaration = analysis.declaration(node, node.text);
  if (declaration && ast.isVariableDeclaration(declaration) && declaration.initializer) return initializer(analysis, declaration.initializer, seen);
  return node;
}
function nativeName(analysis: ReturnType<typeof inference>, node: ast.Node, seen = new Set<ast.Node>()): string {
  node = unwrap(node);
  if (seen.has(node)) return "";
  seen.add(node);
  const access = member(node);
  if (access && ["Object", "Reflect"].includes(access.receiver.getText())) return `${access.receiver.getText()}.${access.name}`;
  if (!ast.isIdentifier(node)) return "";
  const declaration = analysis.declaration(node, node.text);
  if (declaration && ast.isVariableDeclaration(declaration) && declaration.initializer) return nativeName(analysis, declaration.initializer, seen);
  const name = declaration && ast.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : node.text;
  return ({ objectCreate: "Object.create", objectDefineProperty: "Object.defineProperty", reflectDefineProperty: "Reflect.defineProperty", ProxyConstructor: "Proxy", SharedArrayBufferConstructor: "SharedArrayBuffer", ArrayBufferConstructor: "ArrayBuffer", arrayFrom: "Array.from" } as Record<string, string>)[name] ?? name;
}

function checkPropertyMap(analysis: ReturnType<typeof inference>, argument: ast.Node | undefined, check: (node: ast.Node | undefined) => void): void {
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
function checkNativeConversions(analysis: ReturnType<typeof inference>, node: ast.Node, check: (node: ast.Node | undefined) => void): void {
  if (!ast.isCallExpression(node) && !ast.isNewExpression(node)) return;
  const name = nativeName(analysis, node.expression), args = node.arguments ?? [];
  if (["Object.defineProperty", "Reflect.defineProperty"].includes(name)) check(args[2]);
  if (["Object.create", "Object.defineProperties"].includes(name)) checkPropertyMap(analysis, args[1], check);
  if (["Proxy", "SharedArrayBuffer", "ArrayBuffer"].includes(name)) check(args[1]);
  if (name === "Array.from") check(args[0]);
}

function scanSource(analysis: ReturnType<typeof inference>, file: ast.SourceFile, path: string): AuthorityFinding[] {
  const nodes: ast.Node[] = [];
  function visit(node: ast.Node): void {
    if (ast.isCallExpression(node) || ast.isNewExpression(node) || member(node) || ast.isForOfStatement(node) || ast.isSpreadElement(node)) nodes.push(node);
    node.forEachChild(visit);
  }
  visit(file);
  const { infer, isPrivate } = analysis;
  function wrapperBranch(node: ast.Node, receiver: ast.Node): boolean {
    const receiverText = receiver.getText();
    function positive(test: ast.Node): boolean {
      return ast.isCallExpression(test) && test.expression.getText() === "isInstance" && test.arguments[0]?.getText() === receiverText && ["TaggedCells", "OutcomeCell"].includes(test.arguments[1]?.getText() ?? "");
    }
    let child = node;
    for (let parent = child.parent; parent; child = parent, parent = parent.parent) {
      if (ast.isConditionalExpression(parent) && parent.whenTrue === child && positive(parent.condition)) return true;
      if (ast.isIfStatement(parent) && parent.thenStatement === child && positive(parent.expression)) return true;
    }
    return false;
  }
  const findings: AuthorityFinding[] = [];
  function report(node: ast.Node, rule: AuthorityFinding["rule"]): void {
    const finding: AuthorityFinding = { file: path, line: file.text.slice(0, node.getStart()).split("\n").length, scope: scopeOf(node), rule, expression: node.getText() };
    if (!payloadExceptions.some((entry) => entry.file === path && entry.scope === finding.scope && entry.rule === rule && entry.expression === finding.expression)) findings.push(finding);
  }
  function conversionLiteral(argument: ast.Node | undefined): void {
    if (!argument) return;
    const literal = initializer(analysis, argument);
    if (!ast.isObjectLiteralExpression(literal)) return;
    const nullPrototype = literal.properties.some(property => ast.isPropertyAssignment(property)
      && property.name.getText() === "__proto__" && property.initializer.kind === ast.SyntaxKind.NullKeyword);
    if (!nullPrototype) report(literal, "native-conversion");
  }
  for (const node of nodes) {
    checkNativeConversions(analysis, node, conversionLiteral);
    if (path === "proc/intrinsics.ts") continue;
    // WorkerPipeBroker is instantiated only by the trusted page. The codec and
    // endpoint adapters in the SAME module remain checked.
    if (path === "proc/worker-pipes.ts" && scopeOf(node).split(".")[0] === "WorkerPipeBroker") continue;
    if (ast.isForOfStatement(node) || ast.isSpreadElement(node)) {
      if (isPrivate(node.expression)) report(node.expression, "private-iteration");
      continue;
    }
    const access = member(node);
    if (access && isPrivate(access.receiver)) {
      if (access.name === "constructor" || access.name === "Symbol.species" || access.name === "Symbol.iterator") report(node, "species");
      else if (getters.has(access.name) && !wrapperBranch(node, access.receiver)) {
        const names = infer(access.receiver);
        if (Array.from(names).some((name) => views.has(name)) || (["byteLength", "maxByteLength", "growable"].includes(access.name) && names.has("SharedArrayBuffer")) || (access.name === "size" && Array.from(names).some((name) => containers.has(name)))) report(node, "mutable-getter");
      }
    }
    if (!ast.isCallExpression(node) && !ast.isNewExpression(node)) continue;
    const callee = member(node.expression);
    const callText = node.expression.getText();
    if (["setTimeout", "clearTimeout", "queueMicrotask", "structuredClone", "postMessage", "Date"].includes(callText)
      || /^(?:globalThis\.)?(?:crypto\.(?:randomUUID|getRandomValues)|performance\.now|Date\.now|setTimeout|clearTimeout|queueMicrotask|structuredClone|postMessage)$/.test(callText)
      || (callee?.name === "postMessage" && infer(callee.receiver).has("RuntimeWorkerHost"))) report(node, "authority-global");
    let privateArgument = false;
    for (const argument of node.arguments ?? []) if (isPrivate(argument)) { privateArgument = true; break; }
    if (callee) {
      const receiverNames = infer(callee.receiver);
      const nativeReceiver = Array.from(receiverNames).some((name) => views.has(name) || containers.has(name) || name === "SharedArrayBuffer");
      if ((nativeReceiver && !wrapperBranch(node, callee.receiver) && mutableMethods.has(callee.name) && (isPrivate(callee.receiver) || privateArgument)) || (Array.from(receiverNames).some((name) => nativeOwners.has(name) || ["Object", "Reflect", "Atomics", "Array", "Proxy"].includes(name)) && privateArgument) || ((callee.name === "call" || callee.name === "apply" || callee.name === "bind") && receiverNames.has("Function") && (isPrivate(callee.receiver) || privateArgument))) report(node, "mutable-builtin");
    } else if (ast.isCallExpression(node) && infer(node.expression).has("#builtin") && privateArgument) {
      report(node, "mutable-builtin");
    } else if (ast.isNewExpression(node)) {
      // Captured constructor aliases end in Constructor and are module exports,
      // not ambient globals. A new live Map can expose private entries later.
      const names = infer(node.expression);
      if (!names.has("#captured") && Array.from(names).some((name) => views.has(name) || name === "SharedArrayBuffer" || name === "Proxy" || containers.has(name)) && (privateArgument || isPrivate(node))) report(node, "mutable-builtin");
    }
  }
  return findings;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const findings = await scanAuthorityProject(root, [], Bun.argv.includes("--audit-dependencies"));
  for (const finding of findings) console.error(`${finding.file}:${finding.line} ${finding.rule} [${finding.scope}] ${finding.expression.replace(/\s+/g, " ").slice(0, 220)}`);
  console.log(`${findings.length} private-authority boundary findings`);
  if (findings.length) process.exitCode = 1;
}
