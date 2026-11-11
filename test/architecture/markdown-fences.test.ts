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
 * THE RULE IS A HOUSE RULE, stricter than CommonMark in three ways, each on purpose. The guides here
 * are plain: a language on a fence and nothing fancier, so anything fancier is a slip.
 *   1. A fence is three or more backticks (or tildes) at the start of a line, after ANY indentation.
 *      CommonMark stops at three spaces, except inside a list item, where a fence sits deeper. Telling
 *      the two apart needs a parser, and a fence in a nested list must not go unchecked. The price: an
 *      indented code block may not show a fence line.
 *   2. The fence that opens a block may name a language, in ONE word. CommonMark takes any text there
 *      (`js title="x"`). No guide here uses that, and a sentence on an opening fence is a mistake.
 *   3. Every block is closed, by a fence of the same character, at least as long, with nothing after
 *      it. CommonMark closes an open block at the end of the file, and reads a "closing" fence with
 *      text after it as one more line of code. Those two readings are the fault this test is for. It
 *      follows that a block cannot show a fence of its own kind and length: use a longer outer fence.
 * One thing is CommonMark's own and kept: where no block is open, a line of backticks whose rest
 * holds another backtick is no fence (it is a paragraph with code spans), and opens nothing.
 * (The first version of this header said "as CommonMark has it and no stricter". It was stricter in
 * the three ways above and took such a paragraph for a fence: the second reader's last finding.)
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
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) return;
    const [, marks, rest] = fence;
    if (open === undefined) {
      // CommonMark's own: the text on a backtick fence holds no backtick. Such a line is a paragraph.
      if (marks[0] === '`' && rest.includes('`')) return;
      // House rule 2: an opening fence may say a language, in one word.
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

  it('the house rules: a block left open, and an opening fence with more than one word, are faults', () => {
    // CommonMark accepts both (it closes the first at the end of the file, and reads the second as a
    // language with attributes). Here they are mistakes: the header says why.
    expect(fenceFaults('```ts\ncode\n')).toEqual(['line 1: a fence that is never closed']);
    expect(fenceFaults('``` not a language\ncode\n```\n')).toEqual([
      'line 1: an opening fence with more than a language',
    ]);
    expect(fenceFaults('```js title="x"\ncode\n```\n')).toEqual(['line 1: an opening fence with more than a language']);
  });

  it('a line of backticks that holds another backtick is a paragraph, not a fence, and opens nothing', () => {
    // CommonMark's own rule, kept: taken for an opening fence, this line made every later fence of
    // the file pair with the wrong one.
    expect(fenceFaults('``` A `x` b ```\n\n```ts\ncode\n```\n')).toEqual([]);
    // Inside an open block the same line IS the fault this test is for (house rule 3), found once.
    expect(fenceFaults('```ts\ncode\n``` A `x` b.\n\n```ts\nmore\n```\n')).toEqual([
      'line 3: text after a closing fence, so the block never closes',
    ]);
  });

  it('a fence deep inside a nested list is checked like any other', () => {
    const nested = (close: string) => `1. one\n   - two\n\n     \`\`\`ts\n     code\n     ${close}\n`;
    expect(fenceFaults(nested('```'))).toEqual([]);
    expect(fenceFaults(nested('``` and a sentence'))).toEqual([
      'line 6: text after a closing fence, so the block never closes',
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
