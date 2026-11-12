import { test } from 'node:test';
import assert from 'node:assert/strict';

// Plain output is the mode CI logs and agents see, so that is the one pinned here.
process.env.NO_COLOR = '1';
const r = await import('../dist/util/render.js');

test('colour is off under NO_COLOR and nothing is wrapped in escape codes', () => {
  assert.equal(r.RICH, false);
  assert.equal(r.c.red('x'), 'x');
  assert.equal(r.c.bold('hello'), 'hello');
});

test('stripAnsi removes colour codes and displayWidth ignores them', () => {
  const coloured = '\u001b[31mred\u001b[39m';
  assert.equal(r.stripAnsi(coloured), 'red');
  assert.equal(r.displayWidth(coloured), 3);
});

test('displayWidth counts wide characters as two columns', () => {
  assert.equal(r.displayWidth('abc'), 3);
  assert.equal(r.displayWidth('日本'), 4);
});

test('padEnd and padStart pad to the width and never cut text short', () => {
  assert.equal(r.padEnd('ab', 5), 'ab   ');
  assert.equal(r.padStart('ab', 5), '   ab');
  assert.equal(r.padEnd('abcdef', 3), 'abcdef');
});

test('truncate keeps short text and ends long text with an ellipsis within the limit', () => {
  assert.equal(r.truncate('short', 10), 'short');
  const t = r.truncate('a long sentence here', 10);
  assert.ok(r.displayWidth(t) <= 10, t);
  assert.ok(t.endsWith('...'), t);
  assert.equal(r.truncate('anything', 0), '');
});

test('truncatePath drops folders from the left so the filename survives', () => {
  assert.equal(r.truncatePath('docs/a.md', 40), 'docs/a.md');
  const t = r.truncatePath('docs/very/deep/nested/thing.md', 20);
  assert.ok(r.displayWidth(t) <= 20, t);
  assert.ok(t.endsWith('nested/thing.md') || t.endsWith('thing.md'), t);
  assert.ok(t.startsWith('...'), t);
});

test('truncatePath cuts into the filename only when even that does not fit', () => {
  const t = r.truncatePath('docs/averyveryverylongfilename.md', 12);
  assert.ok(r.displayWidth(t) <= 12, t);
  assert.ok(t.endsWith('.md'), t);
  assert.ok(!t.includes('/'), t);
});

test('wrapText never produces a line wider than the width and keeps every word', () => {
  const text = 'the quick brown fox jumps over the lazy dog again and again';
  const lines = r.wrapText(text, 20);
  for (const l of lines) assert.ok(r.displayWidth(l) <= 20, l);
  assert.equal(lines.join(' ').split(/\s+/).join(' '), text);
});

test('wrapText splits a single word that is longer than the line', () => {
  const lines = r.wrapText('x'.repeat(30), 10);
  assert.ok(lines.length >= 3);
  for (const l of lines) assert.ok(r.displayWidth(l) <= 10, l);
  assert.equal(lines.join(''), 'x'.repeat(30));
});

test('wrapText applies the indent to every line', () => {
  const lines = r.wrapText('one two three four five six seven', 16, '  ');
  assert.ok(lines.length > 1);
  for (const l of lines) assert.ok(l.startsWith('  '), l);
});

test('joinWrapped packs fragments and breaks before the width is passed', () => {
  const lines = r.joinWrapped(['aaaa', 'bbbb', 'cccc', 'dddd'], ' | ', 12);
  for (const l of lines) assert.ok(r.displayWidth(l) <= 12, l);
  assert.equal(lines.flatMap((l) => l.split(' | ')).join(','), 'aaaa,bbbb,cccc,dddd');
});

test('humanTokens abbreviates thousands', () => {
  assert.equal(r.humanTokens(950), '950');
  assert.equal(r.humanTokens(1000), '1k');
  assert.equal(r.humanTokens(12345), '12.3k');
  assert.equal(r.humanTokens(250000), '250k');
});

test('bar is always exactly the requested width and clamps the fraction', () => {
  assert.equal(r.bar(0.5, 10), '#####.....');
  assert.equal(r.bar(0, 4), '....');
  assert.equal(r.bar(2, 4), '####');
  assert.equal(r.bar(-1, 4), '....');
});

test('every freshness verdict has a distinct plain marker', () => {
  const kinds = ['fresh', 'drifting', 'stale', 'expired', 'superseded', 'orphaned', 'unverified'];
  const marks = kinds.map((k) => r.markGlyph(k));
  assert.equal(new Set(marks).size, kinds.length);
  for (const m of marks) assert.ok(/^[\x20-\x7e]+$/.test(m), m);
});

test('table pads columns to equal width and stays within the width', () => {
  const lines = r.table(
    [['a', 'one'], ['longer', 'two']],
    [{ align: 'left' }, { align: 'left' }],
    2,
    30,
  );
  assert.equal(lines.length, 2);
  for (const l of lines) assert.ok(r.displayWidth(l) <= 30, l);
});
