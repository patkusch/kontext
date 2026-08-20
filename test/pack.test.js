import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPack, scoreRelevance } from '../dist/core/rank.js';
import { findConflicts } from '../dist/core/conflicts.js';
import { estimateTokens } from '../dist/util/tokens.js';

/** Minimal DocRecord factory — only the fields ranking actually reads. */
function doc(path, { title, body = '', headings = [], tags = [], id, kind, pin } = {}) {
  const t = title ?? path;
  return {
    path,
    frontmatter: { id: id ?? path.replace(/\W+/g, '-'), kind, tags, pin },
    hasFrontmatter: true,
    title: t,
    headings,
    body,
    wordCount: body.split(/\s+/).filter(Boolean).length,
    tokenEstimate: estimateTokens(body),
    contentHash: `hash-${path}`,
  };
}

function report(d, freshness, score) {
  return { doc: d, freshness, score, reasons: [] };
}

test('relevance ranks a title match above a passing body mention', () => {
  const onTopic = doc('docs/session-expiry.md', {
    title: 'Session expiry',
    body: 'How session expiry works.',
  });
  const offTopic = doc('docs/misc.md', {
    title: 'Miscellaneous notes',
    body: 'Lots of unrelated text. We once mentioned session expiry in passing here.',
  });

  const a = scoreRelevance('session expiry', onTopic);
  const b = scoreRelevance('session expiry', offTopic);
  assert.ok(a > b, `title match (${a}) should outrank body mention (${b})`);
  assert.ok(a >= 0 && a <= 1, 'relevance must be normalised 0..1');
});

test('an unrelated doc scores near zero', () => {
  const d = doc('docs/css.md', { title: 'CSS tokens', body: 'Colour variables and spacing.' });
  assert.ok(scoreRelevance('database migration rollback', d) < 0.2);
});

test('freshness demotes an otherwise more relevant doc', () => {
  // This is the entire point of the tool: a stale doc that matches the task
  // perfectly must not outrank a fresh doc that matches slightly less well.
  const staleExact = doc('docs/auth-stale.md', {
    title: 'Auth session expiry',
    body: 'Session expiry details. '.repeat(20),
  });
  const freshClose = doc('docs/auth-fresh.md', {
    title: 'Auth sessions',
    body: 'Session handling details. '.repeat(20),
  });

  const pack = buildPack(
    'auth session expiry',
    [report(staleExact, 'stale', 20), report(freshClose, 'fresh', 95)],
    { budget: 100_000, includeStale: true },
  );

  const order = pack.entries.map((e) => e.path);
  assert.ok(
    order.indexOf('docs/auth-fresh.md') < order.indexOf('docs/auth-stale.md'),
    `fresh doc should rank first, got order: ${order.join(', ')}`,
  );
});

test('a pack never silently omits anything', () => {
  // Silent truncation is indistinguishable, from the inside, from complete
  // knowledge — the worst failure this tool could have.
  const big = doc('docs/big.md', { title: 'Big relevant doc', body: 'session '.repeat(5000) });
  const small = doc('docs/small.md', { title: 'Small session doc', body: 'session expiry notes' });
  const stale = doc('docs/old.md', { title: 'Old session doc', body: 'session expiry legacy' });

  const pack = buildPack(
    'session',
    [report(big, 'fresh', 90), report(small, 'fresh', 90), report(stale, 'stale', 10)],
    { budget: 200 },
  );

  const accountedFor = new Set([
    ...pack.entries.map((e) => e.path),
    ...pack.omitted.map((o) => o.path),
    ...pack.excludedForStaleness.map((o) => o.path),
  ]);

  for (const p of ['docs/big.md', 'docs/small.md', 'docs/old.md']) {
    assert.ok(accountedFor.has(p), `${p} vanished from the pack without explanation`);
  }
  assert.ok(
    pack.excludedForStaleness.some((e) => e.path === 'docs/old.md'),
    'the stale doc must be reported as excluded for staleness',
  );
});

test('a pack respects its token budget', () => {
  const docs = Array.from({ length: 10 }, (_, i) =>
    report(doc(`docs/d${i}.md`, { title: `Session doc ${i}`, body: 'session '.repeat(500) }), 'fresh', 90),
  );
  const budget = 1000;
  const pack = buildPack('session', docs, { budget });
  assert.ok(pack.tokensUsed <= budget, `used ${pack.tokensUsed} of ${budget}`);
  assert.ok(pack.entries.length > 0, 'budget should still admit at least one entry');
});

test('pinned docs are always included', () => {
  const pinned = doc('docs/always.md', { title: 'Totally unrelated', body: 'x', pin: true });
  const pack = buildPack('database migrations', [report(pinned, 'fresh', 90)], { budget: 10_000 });
  assert.ok(pack.entries.some((e) => e.path === 'docs/always.md'), 'pinned doc must survive ranking');
});

test('duplicate content is detected', () => {
  const a = doc('docs/onboarding.md', { title: 'Onboarding', body: 'Clone the repo. Run npm install. Start the server.' });
  const b = doc('docs/getting-started.md', { title: 'Getting started', body: 'Clone the repo. Run npm install. Start the server.' });
  b.contentHash = a.contentHash; // identical normalized body

  const conflicts = findConflicts([a, b]);
  assert.ok(
    conflicts.some((c) => c.kind === 'duplicate'),
    `expected a duplicate conflict, got: ${JSON.stringify(conflicts)}`,
  );
});

test('duplicate ids are detected', () => {
  const a = doc('docs/a.md', { id: 'same-id', body: 'one' });
  const b = doc('docs/b.md', { id: 'same-id', body: 'two' });
  const conflicts = findConflicts([a, b]);
  assert.ok(conflicts.some((c) => c.kind === 'duplicate-id'));
});

test('conflict detection is conservative on unrelated docs', () => {
  // A false contradiction costs trust in the tool, which is worth more than
  // catching a marginal real one.
  const a = doc('docs/a.md', { title: 'Auth', body: 'We use JWTs for sessions.' });
  const b = doc('docs/b.md', { title: 'Styling', body: 'We use CSS custom properties.' });
  const conflicts = findConflicts([a, b]);
  assert.equal(conflicts.length, 0, `expected no conflicts, got: ${JSON.stringify(conflicts)}`);
});
