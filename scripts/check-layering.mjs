/** Standalone record fence: a closed L0–L3 graph, no engine or platform dependencies. */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ranks = JSON.parse(readFileSync(new URL('./layers.json', import.meta.url), 'utf8'));
const list = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? list(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);

export function checkLayers(root = ROOT, layers = ranks) {
  const files = list(join(root, 'src'));
  const local = f => relative(root, f).split('\\').join('/');
  const known = new Set(files.map(local));
  const problems = [];
  const config = ts.parseJsonConfigFileContent(ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, root);
  const graph = new Map();
  for (const file of files) {
    const name = local(file);
    const rank = layers[name];
    if (rank === undefined) problems.push(`unranked source: ${name}`);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
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
  const program = ts.createProgram(files, { ...config.options, noEmit: true, types: [] });
  for (const error of ts.getPreEmitDiagnostics(program)) problems.push(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  return { files: files.length, problems, ok: problems.length === 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = checkLayers();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
