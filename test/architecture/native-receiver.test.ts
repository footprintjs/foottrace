/**
 * The native receiver rule: a browser's host functions (`structuredClone`,
 * `setTimeout`, `fetch`, ...) belong to the global object and throw
 * `TypeError: Illegal invocation` when called as a method of anything else.
 * Node does not check, so a stored copy called as `this.copy(...)` passes
 * every Node suite and fails in a browser (2.3.0, `RecordedPayload`: no stage
 * could commit and no record could replay).
 *
 * The rule: `src/` calls them directly. It never stores one as a field,
 * default value, property or destructured name, and never passes one as a
 * value. A call through the global object (`globalThis.fetch(...)`, an alias
 * of it, or a literal key) is direct: its receiver is the global. The one
 * allowed indirect shape is an operand of `??` or `||` whose result is called
 * at once, `(reader.copy ?? structuredClone)(value)`, which calls with no
 * receiver. A `typeof` check reads no value.
 *
 * Names are resolved by the TypeScript checker, the way the compiler resolves
 * them: a host function is a symbol the default library declares, so a local
 * of the same name is not one (shadowing is by scope), and an alias of the
 * global object or a literal key reaches the same symbol. A key the checker
 * cannot resolve, on an object that carries host functions, is refused. Out of
 * reach: a value typed `any`, and `Reflect` calls; neither appears in `src/`.
 */
import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');

/** Host functions a browser binds to the global object. */
const NATIVE = new Set([
  'structuredClone',
  'queueMicrotask',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'fetch',
  'atob',
  'btoa',
  'reportError',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]);

/** The library's own compiler settings (tsconfig.json): the default library is ES2022 plus DOM, no ambient types. */
const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  types: [],
  strict: true,
  noEmit: true,
  skipLibCheck: true,
};

function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')
      ? [path]
      : [];
  });
}

/** A program over files on disk, or over in-memory files keyed by an absolute name. */
function programOf(roots: string[], memory: Record<string, string> = {}): ts.Program {
  const host = ts.createCompilerHost(OPTIONS);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (name) => memory[name] ?? readFile(name);
  host.fileExists = (name) => name in memory || fileExists(name);
  host.getSourceFile = (name, language, ...rest) =>
    name in memory ? ts.createSourceFile(name, memory[name], language, true) : getSourceFile(name, language, ...rest);
  return ts.createProgram(roots, OPTIONS, host);
}

function inTypePosition(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (ts.isTypeNode(at)) return true;
  }
  return false;
}

/** The reference is called at once, directly or as `(a ?? native)(...)`, or only tested with `typeof`. */
function readsNoValue(reference: ts.Node): boolean {
  let at = reference;
  while (
    ts.isBinaryExpression(at.parent) &&
    (at.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      at.parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  )
    at = at.parent;
  while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
  if (ts.isCallExpression(at.parent) && at.parent.expression === at) return true;
  return at === reference && ts.isTypeOfExpression(reference.parent);
}

/** Every place in `source` a host function is reached other than by a direct call, as `file:line name`. */
export function nativeValueUses(program: ts.Program, source: ts.SourceFile, fileName = source.fileName): string[] {
  const checker = program.getTypeChecker();
  const hostFunction = (symbol: ts.Symbol | undefined): boolean => {
    if (symbol === undefined) return false;
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const declarations = target.declarations ?? [];
    return (
      NATIVE.has(target.name) &&
      declarations.length > 0 &&
      declarations.every((d) => program.isSourceFileDefaultLibrary(d.getSourceFile()))
    );
  };
  const carriesHostFunctions = (object: ts.Expression): boolean => {
    const type = checker.getTypeAtLocation(object);
    return [...NATIVE].some((name) => hostFunction(checker.getPropertyOfType(type, name)));
  };
  const found: string[] = [];
  const report = (node: ts.Node, name: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push(`${fileName}:${line + 1} ${name}`);
  };

  const visit = (node: ts.Node): void => {
    if (inTypePosition(node)) return;
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      // `const { fetch } = globalThis` stores the host function under a new name.
      const key = node.propertyName ?? node.name;
      if (ts.isIdentifier(key) || ts.isStringLiteral(key)) {
        const property = checker.getPropertyOfType(checker.getTypeAtLocation(node.parent), key.text);
        if (hostFunction(property)) report(key, key.text);
      }
      if (!ts.isIdentifier(node.name)) visit(node.name);
      if (node.initializer !== undefined) visit(node.initializer);
      return;
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      // `{ fetch }` stores the value the name resolves to.
      if (hostFunction(checker.getShorthandAssignmentValueSymbol(node))) report(node.name, node.name.text);
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      if (ts.isStringLiteralLike(key)) {
        if (hostFunction(checker.getSymbolAtLocation(key)) && !readsNoValue(node)) report(key, key.text);
      } else if (carriesHostFunctions(node.expression)) {
        report(key, `[${key.getText(source)}]`);
      }
    }
    if (ts.isIdentifier(node) && hostFunction(checker.getSymbolAtLocation(node))) {
      const parent = node.parent;
      const reference = ts.isPropertyAccessExpression(parent) && parent.name === node ? parent : node;
      if (!readsNoValue(reference)) report(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Type-checking the whole source tree with the DOM library takes about 1.7 s on a laptop and passed the 5 s default
 * on the hosted runners while the rest of the suite ran beside it, so this one test states its own limit.
 */
const SOURCE_SCAN_TIMEOUT_MS = 60_000;

describe('the native receiver rule', () => {
  it(
    'src/ calls every host function directly',
    () => {
      const files = sourceFiles(join(ROOT, 'src'));
      const program = programOf(files);
      const found = files.flatMap((file) =>
        nativeValueUses(program, program.getSourceFile(file)!, relative(ROOT, file)),
      );
      expect(found).toEqual([]);
    },
    SOURCE_SCAN_TIMEOUT_MS,
  );

  const refused: [string, string][] = [
    ['a default constructor value (2.3.0)', 'class A { constructor(private readonly copy = structuredClone) {} }'],
    ['a field', 'class A { copy = structuredClone; }'],
    ['an object property', 'const reader = { copyValue: structuredClone };'],
    ['a shorthand property', 'const reader = { fetch };'],
    ['a stored global property', 'const copy = globalThis.structuredClone;'],
    ['a stored window property', 'const later = window.setTimeout;'],
    ['a value passed on', 'declare function run(f: unknown): void; run(setTimeout);'],
    ['an assignment', 'let later: unknown; later = queueMicrotask;'],
    [
      'a fallback stored, not called',
      'declare const reader: { copy?: typeof structuredClone }; const copy = reader.copy ?? structuredClone;',
    ],
    ['a literal key on the global object', "const reader = { copyValue: globalThis['structuredClone'] };"],
    [
      'a property of an alias of the global object',
      'const host = globalThis; const reader = { copyValue: host.structuredClone };',
    ],
    ['a literal key on an alias of an alias', "const g = globalThis; const h = g; const later = h['fetch'];"],
    ['destructuring from the global object', 'const { structuredClone: copy } = globalThis;'],
    ['destructuring from an alias', 'const host = globalThis; const { fetch } = host;'],
    ['a key the checker cannot resolve', "declare const name: 'fetch' | 'atob'; const later = globalThis[name];"],
    [
      'a global property, beside a same-named parameter of another function',
      'function other(structuredClone: unknown) { return structuredClone; } const reader = { copyValue: globalThis.structuredClone };',
    ],
    [
      'a bare name, beside a same-named local in another block',
      '{ const fetch = () => 1; void fetch; } const reader = { fetch };',
    ],
  ];

  const allowed: [string, string][] = [
    ['a direct call', 'declare const a: unknown; const b = structuredClone(a);'],
    [
      'a called fallback',
      'declare const reader: { copy?: typeof structuredClone }; declare const a: unknown; const b = (reader.copy ?? structuredClone)(a);',
    ],
    ['a call through the global object', 'const b = globalThis.structuredClone({});'],
    ['a call through a literal key', "const b = globalThis['structuredClone']({});"],
    ['a call through an alias of the global object', 'const host = globalThis; const b = host.structuredClone({});'],
    ['a type query', 'let timer: ReturnType<typeof setTimeout> | undefined; void timer;'],
    ['a typeof check', "const has = typeof queueMicrotask === 'function';"],
    ['a member of the same name', 'class A { fetch() { return this.fetch; } }'],
    ['a property key', 'const options = { fetch: 1 };'],
    ['a local of the same name', 'const fetch = () => 1; const again = fetch;'],
    [
      'a same-named parameter, in its own function',
      'function other(structuredClone: (v: unknown) => unknown) { return structuredClone; } const b = globalThis.structuredClone({});',
    ],
  ];

  // One program for every control: each is its own module, so names do not collide.
  const memory: Record<string, string> = {};
  const nameOf = (kind: string, i: number) => join(ROOT, '__native_receiver_probe__', `${kind}-${i}.ts`);
  refused.forEach(([, text], i) => (memory[nameOf('refused', i)] = `export {};\n${text}\n`));
  allowed.forEach(([, text], i) => (memory[nameOf('allowed', i)] = `export {};\n${text}\n`));
  const probes = programOf(Object.keys(memory), memory);
  const usesIn = (kind: string, i: number) =>
    nativeValueUses(probes, probes.getSourceFile(nameOf(kind, i))!, 'probe.ts');

  it.each(refused.map(([label], i) => [label, i] as const))('refuses %s', (_label, i) => {
    expect(usesIn('refused', i)).toHaveLength(1);
  });

  it.each(allowed.map(([label], i) => [label, i] as const))('allows %s', (_label, i) => {
    expect(usesIn('allowed', i)).toEqual([]);
  });
});
