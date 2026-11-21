import { join, relative, resolve } from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '../..');
const NATIVE_GLOBALS = new Set(['structuredClone', 'queueMicrotask', 'setTimeout', 'clearTimeout', 'fetch']);

function unwrap(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function receiverViolations(program: ts.Program, files: readonly ts.SourceFile[]): string[] {
  const checker = program.getTypeChecker();
  const assigned = new Map<ts.Symbol, string>();
  const calls: ts.CallExpression[] = [];

  function memberSymbol(expression: ts.Expression): ts.Symbol | undefined {
    if (ts.isPropertyAccessExpression(expression)) return checker.getSymbolAtLocation(expression.name);
    if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) {
      return checker.getPropertyOfType(
        checker.getNonNullableType(checker.getTypeAtLocation(expression.expression)),
        expression.argumentExpression.text,
      );
    }
    return undefined;
  }

  function fromSymbol(symbol: ts.Symbol, seen: Set<ts.Symbol>): string | undefined {
    if (seen.has(symbol)) return undefined;
    seen.add(symbol);
    const name = symbol.getName();
    if (
      NATIVE_GLOBALS.has(name) &&
      symbol.declarations?.some((d) => program.isSourceFileDefaultLibrary(d.getSourceFile()))
    ) {
      return name;
    }
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isShorthandPropertyAssignment(declaration)) {
        const value = checker.getShorthandAssignmentValueSymbol(declaration);
        const native = value && fromSymbol(value, seen);
        if (native) return native;
      }
      if (
        ts.isVariableDeclaration(declaration) ||
        ts.isParameter(declaration) ||
        ts.isPropertyDeclaration(declaration) ||
        ts.isPropertyAssignment(declaration)
      ) {
        const native = declaration.initializer && nativeValue(declaration.initializer, seen);
        if (native) return native;
      }
    }
    return undefined;
  }

  function nativeValue(value: ts.Expression, seen = new Set<ts.Symbol>()): string | undefined {
    const expression = unwrap(value);
    const symbol = ts.isIdentifier(expression) ? checker.getSymbolAtLocation(expression) : memberSymbol(expression);
    return symbol && fromSymbol(symbol, seen);
  }

  // Keep declarations and direct assignments tied to their member symbol, so another object with
  // the same property name can safely call its own implementation. This is a static check for
  // visible initializers and assignments, not a data flow analysis of values crossing call boundaries.
  function collect(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const member = memberSymbol(unwrap(node.left));
      const native = member && nativeValue(node.right);
      if (member && native) assigned.set(member, native);
    }
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, collect);
  }

  files.forEach(collect);
  return calls.flatMap((call) => {
    const callee = unwrap(call.expression);
    const member = memberSymbol(callee);
    if (!member || member.declarations?.some((d) => program.isSourceFileDefaultLibrary(d.getSourceFile()))) return [];
    const native = assigned.get(member) ?? fromSymbol(member, new Set());
    if (!native) return [];
    const source = call.getSourceFile();
    const { line } = source.getLineAndCharacterOfPosition(call.getStart());
    return [`${relative(REPO, source.fileName)}:${line + 1}: ${callee.getText()} invokes ${native} as a method`];
  });
}

describe('browser native globals keep a valid receiver', () => {
  it('recognizes fields, parameter properties, object properties and assignments', () => {
    const path = join(REPO, 'src/__native-receiver-probe__.ts');
    const input = [
      'export {};',
      'class Reader {',
      '  private clone = structuredClone;',
      '  constructor(private schedule = queueMicrotask) {}',
      '  run() { this.clone({}); this.schedule(() => {}); }',
      '}',
      'const timers = { set: globalThis.setTimeout, clearTimeout };',
      'timers.set(() => {}, 0); timers.clearTimeout(0);',
      'const alias = fetch;',
      'const client = { request: (path: string) => fetch(path) };',
      'client.request = alias;',
      'client["request"]("/");',
      'const safe = { request: (path: string) => fetch(path) }; safe.request("/");',
      'const direct = { clone: (value: unknown) => structuredClone(value) }; direct.clone({});',
      'const detached = timers.set; detached(() => {}, 0); globalThis.fetch("/");',
      'function local(fetch: () => void) { const obj = { fetch }; obj.fetch(); }',
    ].join('\n');
    const options = { target: ts.ScriptTarget.ES2022, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], types: [] };
    const host = ts.createCompilerHost(options);
    const read = host.getSourceFile.bind(host);
    host.getSourceFile = (file, version, ...rest) =>
      file === path ? ts.createSourceFile(file, input, version) : read(file, version, ...rest);
    const program = ts.createProgram([path], options, host);

    expect(receiverViolations(program, [program.getSourceFile(path)!])).toEqual([
      'src/__native-receiver-probe__.ts:5: this.clone invokes structuredClone as a method',
      'src/__native-receiver-probe__.ts:5: this.schedule invokes queueMicrotask as a method',
      'src/__native-receiver-probe__.ts:8: timers.set invokes setTimeout as a method',
      'src/__native-receiver-probe__.ts:8: timers.clearTimeout invokes clearTimeout as a method',
      'src/__native-receiver-probe__.ts:12: client["request"] invokes fetch as a method',
    ]);
  });

  it('scans the production sources for calls that bind a native global to another receiver', () => {
    const config = ts.readConfigFile(join(REPO, 'tsconfig.json'), ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, REPO);
    expect(parsed.errors).toEqual([]);
    expect(parsed.fileNames).toContain(join(REPO, 'src/lib/memory/verbs.ts'));
    const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
    const files = parsed.fileNames.map((name) => program.getSourceFile(name)!);
    expect(receiverViolations(program, files)).toEqual([]);
  });
});
