/** Optional reader doors keep one public name per declaration and no engine dependency. */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const entries = { '.': 'index', './write': 'write', './paths': 'paths', './cause': 'cause', './prov': 'prov' } as const;
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
  it('has five code doors with matching public ESM and CommonJS targets', () => {
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
      'causalChainFromCommit',
    ];
    for (const exports of Object.values(exportsByDoor))
      for (const name of privateNames) expect(exports.has(name), name).toBe(false);
  });

  it('has no runtime dependencies and neither installs nor loads footprintjs', () => {
    expect(pkg.dependencies ?? {}).toEqual({});
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

/**
 * Every public name foottrace 1.0.3 shipped, by door — read off `main` at 1.0.3 with this file's own checker.
 * A minor keeps every one on the same door (1.1.0 only adds); only a major may drop or move one.
 */
const SHIPPED_1_0_3: Record<Exclude<keyof typeof entries, './cause' | './prov'>, readonly string[]> = {
  '.': [
    'ArrayProvenance',
    'AttributionBasis',
    'AxisRefusal',
    'AxisSplit',
    'BookendedAxis',
    'CausalChainOptions',
    'CausalEdge',
    'CausalNode',
    'CommitBundle',
    'CommitIdx',
    'CommitPhase',
    'CommitRangeIndex',
    'CommitValuesMode',
    'ControlDepLookup',
    'ControlDependency',
    'EXECUTION_DELIMITER',
    'EdgeWeigher',
    'ElementBirth',
    'EmitSourcePosition',
    'ExecutionCounter',
    'ExecutionIndex',
    'ExecutionTree',
    'FedBasis',
    'FoldBasis',
    'FoldSource',
    'FoldedState',
    'ForwardEdge',
    'ForwardNode',
    'ForwardRead',
    'ForwardSlice',
    'ForwardSliceForKeyOptions',
    'ForwardSliceJSON',
    'HONESTY_CODES',
    'HonestyCode',
    'HonestyNote',
    'HonestyNoteCode',
    'KeyMoment',
    'KeyTimeline',
    'KeyTimelineOptions',
    'KeysReadLookup',
    'KeysReadSource',
    'LogAddress',
    'LogGap',
    'Mark',
    'MemoryPatch',
    'MissingProvenanceReason',
    'MissingSliceReason',
    'Move',
    'MoveRefusal',
    'PATH_DELIMITER',
    'RangeEntry',
    'RangeToken',
    'ReadsCoverage',
    'RuntimeStageId',
    'SliceForKeyOptions',
    'SliceJSON',
    'StateKey',
    'Stop',
    'StopFilter',
    'StopKind',
    'TimeTravel',
    'TimeTravelOptions',
    'TimeTravelSource',
    'TimeTravelStrategy',
    'TraceEntry',
    'UnknownVerbError',
    'UntrackedSource',
    'ValueBasis',
    'ValueBasisOptions',
    'ValueWithBasis',
    'VariableSlice',
    'WriterBasis',
    'WriterWithBasis',
    'applySmartMerge',
    'arrayProvenance',
    'buildCommitIndex',
    'buildRuntimeStageId',
    'causalChain',
    'commitIndexOf',
    'commitStops',
    'commitStopsStrategy',
    'commitValueAt',
    'commitValueAtWithBasis',
    'createExecutionCounter',
    'deepEqual',
    'elementProvenance',
    'filterStops',
    'findCommit',
    'findCommits',
    'findLastWriter',
    'findLastWriterWithBasis',
    'flattenCausalDAG',
    'formatCausalChain',
    'formatForwardSlice',
    'formatSlice',
    'formatTimeline',
    'forwardSliceForKey',
    'forwardSliceToJSON',
    'idPathSegments',
    'inferLegacyPhases',
    'isCommitBundle',
    'isExecutionKey',
    'joinPath',
    'keyTimeline',
    'keysReadFromExecutionTree',
    'keysReadFromMap',
    'parseRuntimeStageId',
    'recordsPhases',
    'resolveKeysReadSource',
    'serveRecord',
    'sliceForKey',
    'sliceToJSON',
    'splitAxis',
    'splitStageId',
    'stageIdOf',
    'stateAt',
    'subflowSegmentsOf',
    'tagStops',
    'timeTravel',
  ],
  './write': [
    'CommitStamp',
    'EventLog',
    'LOG_PLACEHOLDER',
    'RecordEncoding',
    'RecordFrame',
    'SharedMemory',
    'WriteProvenanceMode',
    'WriteScrub',
    'WriteVerb',
    'deepFreeze',
    'freezeRecord',
  ],
  './paths': [
    'isDeniedSegment',
    'nativeGet',
    'nativeHas',
    'normaliseStateKey',
    'pathSegments',
    'setNestedValue',
    'updateNestedValue',
  ],
};

describe('a minor removes nothing', () => {
  it('every name 1.0.3 shipped is still exported, from the same door', () => {
    for (const [door, names] of Object.entries(SHIPPED_1_0_3)) {
      const missing = names.filter((name) => !exportsByDoor[door].has(name));
      expect(missing, door).toEqual([]);
    }
  });

  it('1.1.0 adds the attempt ids and the stored-record reader to the root and the sink port to /write; its helpers stay private', () => {
    const added = {
      '.': [
        'AttemptId',
        'buildAttemptId',
        'parseAttemptId',
        'readStoredRecord',
        'StoredRecord',
        'StoredLog',
        'StoredNote',
        'StoredRecordLimits',
        'LogOutcome',
        'Meta',
      ],
      './write': ['RecordSink', 'RecordEntry', 'memorySink'],
    };
    for (const [door, names] of Object.entries(added))
      for (const name of names) expect(exportsByDoor[door].has(name), `${door}: ${name}`).toBe(true);
    const helpers = [
      'sendEntry',
      'isEntryObject',
      'LOG_OUTCOMES',
      'absentRow',
      'readLog',
      'bundleRefusal',
      'isPlainish',
      'DEFAULT_LIMITS',
    ];
    for (const exports of Object.values(exportsByDoor))
      for (const name of helpers) expect(exports.has(name), name).toBe(false);
  });
});

describe('cause reader public ownership', () => {
  it('keeps producer attention types at the root and reader algorithms on their optional door', () => {
    for (const name of ['Attention', 'AttentionKind']) {
      expect(exportsByDoor['.'].has(name), name).toBe(true);
      expect(exportsByDoor['./cause'].has(name), name).toBe(false);
    }
    for (const name of [
      'explain',
      'attentionList',
      'largestDrop',
      'mostAffected',
      'createRecordGraph',
      'createStoredRecordGraph',
    ]) {
      expect(exportsByDoor['./cause'].has(name), name).toBe(true);
      expect(exportsByDoor['.'].has(name), name).toBe(false);
    }
    for (const name of ['Session', 'walk', 'projectAttention', 'readOwn', 'DEFAULT_LIMITS']) {
      for (const exports of Object.values(exportsByDoor)) expect(exports.has(name), name).toBe(false);
    }
    const rootSource = program.getSourceFile(join(root, 'src/index.ts'))!;
    const attentionExport = rootSource.statements.find(
      (node) =>
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === './lib/cause/types.js',
    );
    expect(attentionExport && ts.isExportDeclaration(attentionExport) && attentionExport.isTypeOnly).toBe(true);
  });
});

describe('reference-only evidence requirements', () => {
  it('keeps producer contracts and their structural reader at the root, with one named gap-code owner', () => {
    for (const name of [
      'RequirementResult',
      'RequirementCheck',
      'RequirementCheckDisposition',
      'RequirementReason',
      'readRequirementResults',
      'RequirementValidationError',
      'REQUIREMENT_RESULT_LIMITS',
    ]) {
      expect(exportsByDoor['.'].has(name), name).toBe(true);
      expect(exportsByDoor['./cause'].has(name), name).toBe(false);
    }
    expect(exportsByDoor['./cause'].has('GapCode')).toBe(true);
    expect(exportsByDoor['.'].has('GapCode')).toBe(false);
    for (const exports of Object.values(exportsByDoor))
      for (const name of ['GAP_CODES', 'isGapCode', 'isRequirementReason', 'EvidenceRefusal', 'ownData', 'boundedList'])
        expect(exports.has(name), name).toBe(false);
  });
});

describe('PROV export public ownership', () => {
  it('keeps the asynchronous exporter and its contracts on the optional door only', () => {
    for (const name of [
      'exportProv',
      'ProvExportRefusal',
      'ProvExport',
      'ProvExportOptions',
      'ProvExportGap',
      'ProvDocument',
      'ProvNode',
    ]) {
      expect(exportsByDoor['./prov'].has(name), name).toBe(true);
      for (const door of ['.', './write', './paths', './cause']) {
        expect(exportsByDoor[door].has(name), door + ': ' + name).toBe(false);
      }
    }
    for (const name of ['admitProvRecord', 'ProvBudget', 'ProvOutput', 'ProvIds', 'provOptions', 'PROV_CONTEXT']) {
      for (const exports of Object.values(exportsByDoor)) expect(exports.has(name), name).toBe(false);
    }
  });
});
