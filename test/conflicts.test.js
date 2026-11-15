import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findConflicts } from '../dist/core/conflicts.js';

// The rule for this feature is precision over recall: a false "contradiction" costs more trust
// than a missed one. So half of these tests are about what must NOT be flagged.

const doc = (path, body, fm = {}) => ({
  path,
  frontmatter: { id: path, ...fm },
  hasFrontmatter: true,
  title: path,
  headings: [],
  body,
  wordCount: body.split(/\s+/).filter(Boolean).length,
  tokenEstimate: 1,
  contentHash: `hash-${path}`,
});

const only = (docs) => findConflicts(docs);

test('two docs giving different PORT values are a high-severity contradiction with quotable evidence', () => {
  const [c, ...rest] = only([doc('a.md', 'Setup\n\nPORT=8080\n'), doc('b.md', 'Config\n\nPORT=3000\n')]);
  assert.equal(rest.length, 0);
  assert.equal(c.kind, 'contradiction');
  assert.equal(c.severity, 'high');
  assert.deepEqual(c.docs, ['a.md', 'b.md']);
  assert.match(c.detail, /docs disagree on environment variable `PORT`: `8080` \(a\.md\) vs `3000` \(b\.md\)/);
  assert.ok(c.evidence.some((e) => /^a\.md \(body line \d+\): PORT=8080/.test(e)), c.evidence.join('\n'));
  assert.ok(c.evidence.some((e) => /^b\.md \(body line \d+\): PORT=3000/.test(e)));
});

test('the same value in two docs is agreement, not a conflict', () => {
  assert.deepEqual(only([doc('a.md', 'PORT=8080\n'), doc('b.md', 'PORT=8080\n')]), []);
});

test('placeholders are examples, not claims, so they never conflict with a real value', () => {
  for (const placeholder of ['<your-key>', '${KEY}', 'xxx', 'changeme', 'your_api_key', '...', 'TODO']) {
    assert.deepEqual(only([doc('a.md', `API_KEY=${placeholder}\n`), doc('b.md', 'API_KEY=abc123\n')]), [], placeholder);
  }
});

test('prose that merely mentions an assignment is not read as one', () => {
  assert.deepEqual(only([doc('a.md', 'Set FOO_BAR = whatever you like to change it.\n'), doc('b.md', 'FOO_BAR=7\n')]), []);
});

test('toolchain versions: a different major is a contradiction, ranges and minors are not', () => {
  const node = only([doc('a.md', 'Requires Node 18.\n'), doc('b.md', 'Requires Node 20.\n')]);
  assert.equal(node.length, 1);
  assert.equal(node[0].severity, 'medium');
  assert.match(node[0].detail, /toolchain version `node`: `18` \(a\.md\) vs `20` \(b\.md\)/);

  assert.deepEqual(only([doc('a.md', 'Requires Node >= 18.\n'), doc('b.md', 'Requires Node 20.\n')]), [], 'a range is compatible');
  assert.deepEqual(only([doc('a.md', 'Requires Node 20.1.\n'), doc('b.md', 'Requires Node 20.4.\n')]), [], 'same major');
  assert.deepEqual(only([doc('a.md', 'Requires Node 18+.\n'), doc('b.md', 'Requires Node 20.\n')]), [], '18+ is a range');
});

test('python is compared on major.minor, because 3.10 and 3.12 really differ', () => {
  const [c] = only([doc('a.md', 'Needs Python 3.10.\n'), doc('b.md', 'Needs Python 3.12.\n')]);
  assert.match(c.detail, /`python`: `3\.10` \(a\.md\) vs `3\.12` \(b\.md\)/);
});

test('a labelled service URL is compared by host and port, medium severity', () => {
  const [c] = only([doc('a.md', 'BASE_URL: https://api.example.com\n'), doc('b.md', 'BASE_URL: https://api.other.com\n')]);
  assert.equal(c.severity, 'medium');
  assert.match(c.detail, /service URL/);
  assert.deepEqual(only([doc('a.md', 'BASE_URL: https://api.example.com/v1\n'), doc('b.md', 'BASE_URL: https://api.example.com/v2\n')]), [], 'paths differ legitimately');
});

test('different localhost ports are the lowest severity; a doc that mentions two ports abstains', () => {
  const [c] = only([doc('a.md', 'Open http://localhost:3000\n'), doc('b.md', 'Open http://localhost:4000\n')]);
  assert.equal(c.severity, 'low');
  assert.match(c.detail, /local port/);
  assert.deepEqual(only([doc('a.md', 'App on http://localhost:3000 and db on localhost:5432\n'), doc('b.md', 'App on http://localhost:3000\n')]), []);
});

test('history is allowed to disagree: archive folders, changelogs and superseded docs are skipped', () => {
  assert.deepEqual(only([doc('docs/archive/a.md', 'PORT=8080\n'), doc('b.md', 'PORT=3000\n')]), []);
  assert.deepEqual(only([doc('docs/legacy/a.md', 'PORT=8080\n'), doc('b.md', 'PORT=3000\n')]), []);
  assert.deepEqual(only([doc('CHANGELOG.md', 'PORT=8080\n'), doc('b.md', 'PORT=3000\n')]), []);
  const superseded = only([doc('a.md', 'PORT=8080\n', { id: 'old' }), doc('b.md', 'PORT=3000\n', { id: 'new', supersedes: ['old'] })]);
  assert.deepEqual(superseded, []);
});

test('a doc that contradicts itself is not flagged against itself', () => {
  assert.deepEqual(only([doc('a.md', 'PORT=8080\n\nlater\n\nPORT=3000\n')]), []);
});

const LONG = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega '.repeat(3);

test('near-copies are reported as duplicates with the percentage of shared phrases', () => {
  const [c] = only([doc('a.md', `${LONG} end one`), doc('b.md', `${LONG} end two`)]);
  assert.equal(c.kind, 'duplicate');
  assert.equal(c.severity, 'high');
  assert.match(c.detail, /^\d+% of 5-word phrases are shared/);
  assert.ok(c.evidence.some((e) => /Jaccard similarity 0\.\d+ \(threshold 0\.8\)/.test(e)));
});

test('docs that merely share a topic are not duplicates', () => {
  const other = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty '.repeat(3);
  assert.deepEqual(only([doc('a.md', LONG), doc('b.md', other)]), []);
});

test('very short docs are never compared for similarity, so stubs and boilerplate stay quiet', () => {
  assert.deepEqual(only([doc('a.md', 'short text here'), doc('b.md', 'short text here')]), []);
});

test('byte-identical bodies are a high-severity duplicate even when short', () => {
  const a = doc('a.md', 'same body');
  const b = doc('b.md', 'same body');
  a.contentHash = b.contentHash = 'identical';
  const [c] = only([a, b]);
  assert.equal(c.kind, 'duplicate');
  assert.equal(c.severity, 'high');
  assert.match(c.detail, /2 docs have byte-identical bodies/);
});

test('a third doc that is a near-copy of an identical pair is still found', () => {
  const a = doc('a.md', `${LONG} end`);
  const b = doc('b.md', `${LONG} end`);
  a.contentHash = b.contentHash = 'same';
  const c = doc('c.md', `${LONG} finish`);
  const found = only([a, b, c]);
  assert.ok(found.some((x) => x.detail.includes('byte-identical')));
  assert.ok(found.some((x) => x.detail.includes('5-word phrases') && x.docs.includes('c.md')));
});

test('two docs with the same id are reported, ignoring blank ids and counting the group', () => {
  const found = only([doc('a.md', 'one', { id: 'dup' }), doc('b.md', 'two', { id: 'dup' }), doc('c.md', 'three', { id: 'dup' }), doc('d.md', 'four', { id: '  ' }), doc('e.md', 'five', { id: '  ' })]);
  const dup = found.filter((c) => c.kind === 'duplicate-id');
  assert.equal(dup.length, 1);
  assert.equal(dup[0].severity, 'high');
  assert.deepEqual(dup[0].docs, ['a.md', 'b.md', 'c.md']);
  assert.match(dup[0].detail, /3 docs declare the same frontmatter id `dup`/);
});

test('results come back worst first', () => {
  const found = only([
    doc('a.md', 'PORT=8080\n\nOpen http://localhost:3000\n', { id: 'x1' }),
    doc('b.md', 'PORT=3000\n\nOpen http://localhost:4000\n', { id: 'x2' }),
    doc('c.md', 'Requires Node 18.\n', { id: 'dup' }),
    doc('d.md', 'Requires Node 20.\n', { id: 'dup' }),
  ]);
  const order = { high: 0, medium: 1, low: 2 };
  const ranks = found.map((c) => order[c.severity]);
  assert.deepEqual(ranks, [...ranks].sort((p, q) => p - q));
  assert.ok(found.length >= 4);
});

test('no docs, or one doc, can never produce a conflict', () => {
  assert.deepEqual(only([]), []);
  assert.deepEqual(only([doc('a.md', 'PORT=1\n')]), []);
});
