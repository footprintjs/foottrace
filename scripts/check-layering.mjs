/** Standalone record fence: a closed ranked graph (ranks in layers.json), no engine or platform dependencies, no runtime cycles. */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ranks = JSON.parse(readFileSync(new URL('./layers.json', import.meta.url), 'utf8'));
const list = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? list(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);

export function checkLayers(root = ROOT, layers = ranks) {
  const files = list(join(root, 'src')).filter(file => !file.endsWith('.test.ts'));
  const local = f => relative(root, f).split('\\').join('/');
  const known = new Set(files.map(local));
  const problems = [];
  const config = ts.parseJsonConfigFileContent(ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, root);
  const program = ts.createProgram(files, { ...config.options, noEmit: true, types: [] });
  const checker = program.getTypeChecker();
  // Follow the actual source-owned refusal family, not lookalike class names or source text.
  const refusalInstance = (type, seen = new Set()) => {
    if (seen.has(type)) return false;
    seen.add(type);
    if (type.getSymbol()?.declarations?.some(declaration => ts.isClassDeclaration(declaration) &&
      declaration.name?.text === 'EvidenceRefusal' &&
      local(declaration.getSourceFile().fileName) === 'src/lib/evidence/admission.ts')) return true;
    return (type.getBaseTypes?.() ?? []).some(base => refusalInstance(base, seen));
  };
  const graph = new Map();
  for (const file of files) {
    const name = local(file);
    const rank = layers[name];
    if (rank === undefined) problems.push(`unranked source: ${name}`);
    const source = program.getSourceFile(file);
    const edges = [];
    const edge = (spec, typeOnly = false) => {
      if (!spec.startsWith('.')) { problems.push(`${name}: external dependency ${spec}`); return; }
      const resolved = ts.resolveModuleName(spec, file, config.options, ts.sys).resolvedModule?.resolvedFileName;
      const target = resolved && local(resolved);
      if (!known.has(target)) { problems.push(`${name}: unresolved or non-source import ${spec}`); return; }
      if (!typeOnly && layers[target] > rank) problems.push(`${name} L${rank} -> ${target} L${layers[target]}`);
      if (!typeOnly) edges.push(target);
    };
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        const clause = ts.isImportDeclaration(node) ? node.importClause : node.exportClause;
        const bindings = ts.isImportDeclaration(node) ? clause?.namedBindings : clause;
        const onlyTypes = !!(node.isTypeOnly || clause?.isTypeOnly ||
          (!clause?.name && bindings?.elements?.length && bindings.elements.every(el => el.isTypeOnly)));
        edge(node.moduleSpecifier.text, onlyTypes);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) edge(node.argument.literal.text, true);
      else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) edge(arg.text);
        else problems.push(`${name}: opaque module load`);
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        edge(node.moduleReference.expression.text, node.isTypeOnly);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
        checker.getTypeAtLocation(node.right).getConstructSignatures().some(signature => refusalInstance(signature.getReturnType()))) {
        problems.push(`${name}: dynamic EvidenceRefusal classification; use the family identity reader`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    graph.set(name, edges);
  }
  for (const name of Object.keys(layers)) if (!known.has(name)) problems.push(`stale layer entry: ${name}`);
  const visited = new Set();
  const active = new Set();
  const walk = (name, path = []) => {
    if (active.has(name)) { problems.push(`runtime cycle: ${[...path, name].join(' -> ')}`); return; }
    if (visited.has(name)) return;
    active.add(name);
    for (const next of graph.get(name) ?? []) walk(next, [...path, name]);
    active.delete(name); visited.add(name);
  };
  for (const name of graph.keys()) walk(name);
  // Type checking without Node globals also catches accidental platform API use.
  for (const error of ts.getPreEmitDiagnostics(program)) problems.push(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  return { files: files.length, problems, ok: problems.length === 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = checkLayers();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
