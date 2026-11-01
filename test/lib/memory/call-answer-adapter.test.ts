import { expect, it } from 'vitest';
import { callAnswerAdapterExample } from '../../../examples/call-answer-adapter.js';

it('the worked host adapter reopens call-answer evidence through existing CauseGraph ports', async () => {
  const saved = await callAnswerAdapterExample();
  expect(saved.relatedNotes).toBe(1);
  expect(saved.witness).toEqual([saved.attemptId]);
  expect(saved.result.backward?.edges.some((edge) => edge.from === saved.writer && edge.to === saved.call)).toBe(true);
  expect(saved.result.confidence).toBe('incomplete');
  expect(saved.result.rootCause).toBeUndefined();
  expect(saved.result.gaps.map((gap) => gap.code)).toContain('conservative');
  expect(saved.coverage).toContain('unknown');
});
