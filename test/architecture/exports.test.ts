/** Three doors, one public name per declaration, no engine dependency. */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const entries = { '.': 'index', './write': 'write', './paths': 'paths' } as const;
const config = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile).config,
  ts.sys,
  root,
);
const program = ts.createProgram(
  Object.values(entries).map((name) => join(root, 'src', name + '.ts')),
  {
    ...config.options,
    noEmit: true,
  },
);
const checker = program.getTypeChecker();
const exportsByDoor = Object.fromEntries(
  Object.entries(entries).map(([door, name]) => {
    const source = program.getSourceFile(join(root, 'src', name + '.ts'))!;
    const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(source)!);
    return [
      door,
      new Map(
        exports.map((symbol) => [
          symbol.name,
          symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol,
        ]),
      ),
    ];
  }),
);

function duplicates(doors: typeof exportsByDoor): string[][] {
  const owners = new Map<ts.Symbol, string[]>();
  for (const [door, exports] of Object.entries(doors)) {
    for (const [name, declaration] of exports) {
      const held = owners.get(declaration) ?? [];
      held.push(`${door}: ${name}`);
      owners.set(declaration, held);
    }
  }
  return [...owners.values()].filter((owners) => owners.length > 1);
}

describe('foottrace public ownership', () => {
  it('has exactly three code doors, with matching type and runtime entry points', () => {
    expect(
      Object.keys(pkg.exports)
        .filter((key) => key !== './package.json')
        .sort(),
    ).toEqual(Object.keys(entries).sort());
    for (const [door, name] of Object.entries(entries)) {
      expect(pkg.exports[door].import).toEqual({ types: `./dist/esm/${name}.d.ts`, default: `./dist/esm/${name}.js` });
      expect(pkg.exports[door].require).toEqual({ types: `./dist/types/${name}.d.ts`, default: `./dist/${name}.js` });
      if (door !== '.') expect(pkg.typesVersions['*'][door.slice(2)]).toEqual([`dist/types/${name}.d.ts`]);
    }
  });

  it('gives each declaration one canonical door, resolving aliases', () => {
    expect(duplicates(exportsByDoor)).toEqual([]);
    for (const exports of Object.values(exportsByDoor)) {
      for (const symbol of exports.values()) {
        expect(
          symbol.declarations?.every((decl) => decl.getSourceFile().fileName.startsWith(join(root, 'src') + '/')),
        ).toBe(true);
      }
    }
    expect(exportsByDoor['.'].get('idPathSegments')?.name).toBe('pathSegments');
    expect(exportsByDoor['.'].get('idPathSegments')).not.toBe(exportsByDoor['./paths'].get('pathSegments'));
  });

  it('the ownership check catches a second door even when it renames the export', () => {
    const probe = { ...exportsByDoor, './probe': new Map([['renamedEquality', exportsByDoor['.'].get('deepEqual')!]]) };
    expect(duplicates(probe)).toEqual([['.: deepEqual', './probe: renamedEquality']]);
  });

  it('resolves the extraction internals only through their approved public names', () => {
    const additions = {
      '.': [
        'deepEqual',
        'EXECUTION_DELIMITER',
        'PATH_DELIMITER',
        'isExecutionKey',
        'joinPath',
        'idPathSegments',
        'serveRecord',
        'stageIdOf',
        'subflowSegmentsOf',
      ],
      './write': ['deepFreeze', 'freezeRecord', 'LOG_PLACEHOLDER'],
      './paths': [
        'isDeniedSegment',
        'nativeGet',
        'nativeHas',
        'pathSegments',
        'normaliseStateKey',
        'setNestedValue',
        'updateNestedValue',
      ],
    };
    for (const [door, names] of Object.entries(additions))
      for (const name of names) expect(exportsByDoor[door].has(name), `${door}: ${name}`).toBe(true);
    const privateNames = [
      'ArrayWalk',
      'OpaqueRule',
      'DELIM',
      'lastSegmentOf',
      'TransactionBuffer',
      'deepSmartMerge',
      'getNestedValue',
      'updateValue',
      'normalisePath',
      'getRunAndGlobalPaths',
      'redactPatch',
    ];
    for (const exports of Object.values(exportsByDoor))
      for (const name of privateNames) expect(exports.has(name), name).toBe(false);
  });

  it('has no runtime dependencies and neither installs nor loads footprintjs', () => {
    expect(pkg.dependencies).toEqual({});
    expect(
      Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }).filter((name) =>
        name.startsWith('footprintjs'),
      ),
    ).toEqual([]);
    const require = createRequire(join(root, 'package.json'));
    for (const name of ['footprintjs', 'footprintjs-baseline', 'footprintjs-published'])
      expect(() => require.resolve(name)).toThrow();
    expect(program.getSourceFiles().filter((source) => /node_modules\/footprintjs/.test(source.fileName))).toEqual([]);
  });
});
