import { readFileSync } from 'node:fs';
import type { RecordScope, RecordSourceLink, ServedRow, SourceLinkRow } from '../../../src/cause.js';

type CheckPair = Pick<SourceLinkRow, 'linkBasis' | 'namedBy' | 'check'> & {
  readonly standing?: 'witnessed';
  readonly gap?: string;
};
export const sharedSourceLinksV1 = JSON.parse(readFileSync(new URL('./v1.json', import.meta.url), 'utf8')) as {
  readonly address: RecordScope['address'];
  readonly initialState: NonNullable<RecordScope['initialState']>;
  readonly servedRow: ServedRow;
  readonly witnessRow: SourceLinkRow;
  readonly witness: RecordSourceLink['witness'];
  readonly boundWrite: Pick<RecordSourceLink['output'], 'runtimeStageId' | 'commitIdx'>;
  readonly checkPairs: readonly CheckPair[];
};

export function readEngineSourceLinksFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./engine/${name}.json`, import.meta.url), 'utf8')) as T;
}
