import { explain, type CauseGraph, type CauseResult } from 'foottrace/cause';
import type { Attention } from 'foottrace';

const mark: Attention = { kind: 'error', reason: 'ERROR_RECORDED', evidence: ['proof:source'] };
declare const graph: CauseGraph;
const result: Promise<CauseResult> = explain(graph, 'source');
void mark;
void result;

// @ts-expect-error Public node identities are strings in both module formats.
explain(graph, 1);
