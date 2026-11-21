/**
 * The native receiver rule: a browser's host functions (`structuredClone`,
 * `setTimeout`, `fetch`, ...) belong to the global object and throw
 * `TypeError: Illegal invocation` when called as a method of anything else.
 * Node does not check, so a stored copy called as `this.copy(...)` passes
 * every Node suite and fails in a browser (2.3.0, `RecordedPayload`).
 *
 * The rule: `src/` calls them directly. It never stores one as a field,
 * default value or property, and never passes one as a value. The one
 * allowed indirect shape is an operand of `??` or `||` whose result is
 * called at once, `(reader.copy ?? structuredClone)(value)`, which calls
 * with no receiver.
 */
import { readdirSync, readFileSync } from 'node:fs';
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
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self']);

function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')
      ? [path]
      : [];
  });
}

/** Names the file declares itself: a local `fetch` is not the host's. */
function declaredNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    )
      names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function inTypePosition(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (ts.isTypeNode(at)) return true;
  }
  return false;
}

/** The reference is called at once with no receiver, directly or as `(a ?? native)(...)`. */
function calledWithoutReceiver(reference: ts.Node): boolean {
  let at = reference;
  while (
    ts.isBinaryExpression(at.parent) &&
    (at.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      at.parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  )
    at = at.parent;
  while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
  return ts.isCallExpression(at.parent) && at.parent.expression === at;
}

/** Every place a host function is used as a value instead of called directly, as `file:line name`. */
export function nativeValueUses(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const declared = declaredNames(source);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && NATIVE.has(node.text) && !declared.has(node.text) && !inTypePosition(node)) {
      const parent = node.parent;
      let reference: ts.Node | undefined = node;
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
        // `globalThis.structuredClone` is the host's; `this.fetch` is a member of the same name.
        reference =
          ts.isIdentifier(parent.expression) && GLOBAL_OBJECTS.has(parent.expression.text) ? parent : undefined;
      } else if (
        ((ts.isPropertyAssignment(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isMethodSignature(parent)) &&
          parent.name === node) ||
        ts.isImportSpecifier(parent) ||
        ts.isExportSpecifier(parent)
      ) {
        reference = undefined;
      }
      if (reference !== undefined && !calledWithoutReceiver(reference)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        found.push(`${fileName}:${line + 1} ${node.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the native receiver rule', () => {
  it('src/ calls every host function directly', () => {
    const found = sourceFiles(join(ROOT, 'src')).flatMap((file) =>
      nativeValueUses(relative(ROOT, file), readFileSync(file, 'utf8')),
    );
    expect(found).toEqual([]);
  });

  it.each([
    ['a default constructor value (2.3.0)', 'class A { constructor(private readonly copy = structuredClone) {} }'],
    ['a field', 'class A { copy = structuredClone; }'],
    ['an object property', 'const reader = { copyValue: structuredClone };'],
    ['a shorthand property', 'const reader = { fetch };'],
    ['a stored global property', 'const copy = globalThis.structuredClone;'],
    ['a value passed on', 'run(setTimeout);'],
    ['an assignment', 'let later; later = queueMicrotask;'],
    ['a fallback stored, not called', 'const copy = reader.copy ?? structuredClone;'],
  ])('refuses %s', (_case, text) => {
    expect(nativeValueUses('probe.ts', text)).toHaveLength(1);
  });

  it.each([
    ['a direct call', 'const b = structuredClone(a);'],
    ['a called fallback', 'const b = (reader.copy ?? structuredClone)(a);'],
    ['a call through the global object', 'const b = globalThis.structuredClone(a);'],
    ['a type query', 'let timer: ReturnType<typeof setTimeout> | undefined;'],
    ['a member of the same name', 'class A { fetch() { return this.fetch; } }'],
    ['a property key', 'const options = { fetch: 1 };'],
    ['a local of the same name', 'const fetch = () => 1; const again = fetch;'],
  ])('allows %s', (_case, text) => {
    expect(nativeValueUses('probe.ts', text)).toEqual([]);
  });
});
