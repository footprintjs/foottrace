/**
 * Every code fence in the repository's Markdown opens and closes.
 *
 * WHY THIS TEST EXISTS. A closing fence is a line of backticks and nothing else. An edit once left a
 * sentence on that line (`docs/cause.md`: a paragraph was replaced by a paragraph and a code block,
 * and the end of the old paragraph stayed behind the block's last line). A fence with text after it
 * does not close its block, so the rest of the guide rendered as code and every later fence paired
 * with the wrong one. Nothing failed: the docs are not compiled. The second reader of that change
 * found it by looking at the page.
 *
 * The rule, as CommonMark has it and no stricter: a fence is three or more backticks (or tildes) at
 * the start of a line, after at most three spaces. The one that opens a block may name a language.
 * The one that closes it is of the same character, at least as long, and carries nothing else.
 *
 * Test types: architecture (every tracked `.md` file), unit (the rule itself, on small texts).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
/** Folders that hold what is built or installed, never what is written. */
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.vitest']);

function markdownFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED.has(entry.name)) return [];
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith('.md') ? [path] : [];
  });
}

/** What is wrong with the fences of one Markdown text, one line per fault; empty when nothing is. */
function fenceFaults(text: string): string[] {
  const faults: string[] = [];
  let open: { mark: string; length: number; line: number } | undefined;
  text.split('\n').forEach((line, at) => {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) return;
    const [, marks, rest] = fence;
    if (open === undefined) {
      // An opening fence may say a language: one word, no spaces, and (for backticks) no backtick.
      if (!/^[\w+.#-]*$/.test(rest.trim())) faults.push(`line ${at + 1}: an opening fence with more than a language`);
      open = { mark: marks[0], length: marks.length, line: at + 1 };
    } else if (marks[0] === open.mark && marks.length >= open.length) {
      if (rest.trim() !== '') faults.push(`line ${at + 1}: text after a closing fence, so the block never closes`);
      open = undefined;
    }
    // Any other fence inside an open block is the block's content.
  });
  if (open !== undefined) faults.push(`line ${open.line}: a fence that is never closed`);
  return faults;
}

describe('the rule for code fences', () => {
  it('a block that opens with a language and closes bare is sound', () => {
    expect(fenceFaults('text\n\n```ts\nconst a = 1;\n```\n\nmore')).toEqual([]);
    expect(fenceFaults('- a list\n\n   ```\n   indented\n   ```\n')).toEqual([]);
    expect(fenceFaults('````md\n```ts\ninner\n```\n````\n')).toEqual([]);
  });

  it('text after a closing fence is a fault: the block does not close there', () => {
    expect(fenceFaults('```ts\ncode\n``` A sentence that stayed behind.\n\n## Next\n')).toEqual([
      'line 3: text after a closing fence, so the block never closes',
    ]);
  });

  it('a fence left open, and an opening fence with a sentence on it, are faults', () => {
    expect(fenceFaults('```ts\ncode\n')).toEqual(['line 1: a fence that is never closed']);
    expect(fenceFaults('``` not a language\ncode\n```\n')).toEqual([
      'line 1: an opening fence with more than a language',
    ]);
  });
});

describe("every Markdown file's code fences", () => {
  const files = markdownFiles(ROOT);

  it('finds the guides, the folder READMEs and the change notes', () => {
    const names = files.map((file) => relative(ROOT, file));
    expect(names).toEqual(expect.arrayContaining(['README.md', 'docs/cause.md', 'src/lib/memory/README.md']));
    expect(names.some((name) => name.startsWith('.changes/'))).toBe(true);
  });

  it('open and close, in every one of them', () => {
    const faults = files.flatMap((file) =>
      fenceFaults(readFileSync(file, 'utf8')).map((fault) => `${relative(ROOT, file)}: ${fault}`),
    );
    expect(faults).toEqual([]);
  });
});
