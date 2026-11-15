import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, truncateToTokens } from '../dist/util/tokens.js';

test('empty, blank and non-string input cost nothing and never throw', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('   \n\t '), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(42), 0);
});

test('any real text costs at least one token and the answer is a whole number', () => {
  for (const t of ['a', 'Hello world', '!!!', '日本語', '```\nx\n```']) {
    const n = estimateTokens(t);
    assert.ok(Number.isInteger(n) && n >= 1, `${JSON.stringify(t)} -> ${n}`);
  }
});

test('more text never costs fewer tokens', () => {
  let text = '';
  let last = 0;
  for (let i = 0; i < 30; i += 1) {
    text += 'The session expires after thirty minutes of inactivity. ';
    const n = estimateTokens(text);
    assert.ok(n >= last, `step ${i}: ${n} < ${last}`);
    last = n;
  }
});

test('the same words cost more as code than as prose', () => {
  const words = 'getUserSessionToken validateRequestHeaders refreshAccessToken';
  const prose = estimateTokens(words);
  const code = estimateTokens('```ts\n' + words + '\n```');
  assert.ok(code > prose, `code ${code} should exceed prose ${prose}`);
});

test('East Asian text is counted per character, not as one long word', () => {
  const cjk = estimateTokens('日本語のテキストを数えます');
  assert.ok(cjk >= 12, `got ${cjk}`);
});

test('an unclosed code fence is treated as code to the end, without throwing', () => {
  assert.ok(estimateTokens('Intro\n```js\nconst a = 1;\nconst b = 2;') >= 5);
});

test('text that already fits comes back untouched and not truncated', () => {
  const text = 'A short note.';
  assert.deepEqual(truncateToTokens(text, 1000), { text, truncated: false });
});

test('empty input is never truncated; a zero or bad budget keeps nothing', () => {
  assert.deepEqual(truncateToTokens('', 10), { text: '', truncated: false });
  assert.deepEqual(truncateToTokens('words here', 0), { text: '', truncated: true });
  assert.deepEqual(truncateToTokens('words here', -5), { text: '', truncated: true });
  assert.deepEqual(truncateToTokens('words here', NaN), { text: '', truncated: true });
  assert.deepEqual(truncateToTokens('   ', 0), { text: '', truncated: false });
});

test('a long document is cut on a paragraph boundary and stays within the budget', () => {
  const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} explains one idea about how login sessions work in detail.`);
  const text = paragraphs.join('\n\n');
  const budget = Math.floor(estimateTokens(text) / 2);
  const out = truncateToTokens(text, budget);
  assert.equal(out.truncated, true);
  assert.ok(estimateTokens(out.text) <= budget);
  assert.ok(out.text.length > 0);
  assert.ok(text.startsWith(out.text), 'the kept text is a prefix of the original');
  assert.ok(out.text.endsWith('detail.'), 'it ends at the end of a paragraph, not mid-sentence');
});

test('when the first paragraph alone is too big it falls back to whole sentences', () => {
  const text = 'First sentence is here. Second sentence follows it. Third sentence closes the paragraph with more words.';
  const out = truncateToTokens(text, 12);
  assert.equal(out.truncated, true);
  assert.ok(out.text.endsWith('.'), out.text);
  assert.ok(estimateTokens(out.text) <= 12);
  assert.ok(text.startsWith(out.text));
});

test('with no sentence break to use it cuts by characters but still returns something', () => {
  const text = 'x'.repeat(600);
  const out = truncateToTokens(text, 20);
  assert.equal(out.truncated, true);
  assert.ok(out.text.length > 0 && out.text.length < text.length);
});

test('a cut that lands inside a code block closes the fence so the rest renders as text', () => {
  const text = 'Intro paragraph.\n\n```js\n' + 'const value = compute(a, b, c);\n'.repeat(60) + '```\n\nOutro.';
  const out = truncateToTokens(text, 40);
  assert.equal(out.truncated, true);
  const fences = (out.text.match(/^\s{0,3}```/gm) ?? []).length;
  assert.equal(fences % 2, 0, `unbalanced fences in:\n${out.text}`);
});
