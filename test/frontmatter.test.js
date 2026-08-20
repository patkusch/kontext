import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFrontmatter,
  serializeFrontmatter,
  validateFrontmatter,
} from '../dist/core/frontmatter.js';

test('parses a block frontmatter document', () => {
  const raw = `---
kontext: 1
id: auth-flow
kind: guide
describes:
  - src/auth/**
  - src/middleware/session.ts
tags: [auth, security]
---

# Auth Flow

Body text.`;
  const { data, body, hasFrontmatter } = parseFrontmatter(raw);
  assert.equal(hasFrontmatter, true);
  assert.equal(data.kontext, 1);
  assert.equal(data.id, 'auth-flow');
  assert.deepEqual(data.describes, ['src/auth/**', 'src/middleware/session.ts']);
  assert.deepEqual(data.tags, ['auth', 'security']);
  assert.match(body, /# Auth Flow/);
  assert.doesNotMatch(body, /kontext: 1/);
});

test('a document without frontmatter is normal, not an error', () => {
  const raw = '# Just a doc\n\nNo frontmatter here.';
  const { data, body, hasFrontmatter } = parseFrontmatter(raw);
  assert.equal(hasFrontmatter, false);
  assert.deepEqual(data, {});
  assert.equal(body, raw);
});

test('malformed YAML degrades instead of throwing', () => {
  // Real repos contain broken frontmatter. One bad doc must never take down
  // a whole scan.
  const raw = '---\nid: [unclosed\n  ::: nonsense\n---\n\n# Doc';
  assert.doesNotThrow(() => parseFrontmatter(raw));
  const { hasFrontmatter } = parseFrontmatter(raw);
  assert.equal(typeof hasFrontmatter, 'boolean');
});

test('serialize round-trips through parse', () => {
  const fm = {
    kontext: 1,
    id: 'round-trip',
    kind: 'decision',
    describes: ['src/**/*.ts'],
    tags: ['a', 'b'],
  };
  const out = serializeFrontmatter(fm, '# Title\n\nBody.');
  const { data, hasFrontmatter } = parseFrontmatter(out);
  assert.equal(hasFrontmatter, true);
  assert.equal(data.id, 'round-trip');
  assert.equal(data.kind, 'decision');
  assert.deepEqual(data.describes, ['src/**/*.ts']);
  assert.deepEqual(data.tags, ['a', 'b']);
});

test('validation rejects bad values with actionable messages', () => {
  const bad = validateFrontmatter({ kontext: 1, id: 'Not A Slug', kind: 'nonsense' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 1, 'expected at least one error');
  assert.ok(
    bad.errors.some((e) => /id/i.test(e)) || bad.errors.some((e) => /kind/i.test(e)),
    `errors should name the offending field, got: ${JSON.stringify(bad.errors)}`,
  );

  const good = validateFrontmatter({ kontext: 1, id: 'auth-flow', kind: 'guide' });
  assert.equal(good.ok, true);
  assert.deepEqual(good.errors, []);
});

test('validation catches an impossible expires date', () => {
  const r = validateFrontmatter({ kontext: 1, id: 'x', expires: '2026-13-45' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /expires/i.test(e)));
});
