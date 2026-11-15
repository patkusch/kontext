import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, serializeFrontmatter, validateFrontmatter } from '../dist/core/frontmatter.js';

/* ---- reading ---- */

test('a byte-order mark and Windows line endings do not hide the front matter', () => {
  assert.deepEqual(parseFrontmatter('﻿---\nid: a\n---\nBody\n'), { data: { id: 'a' }, body: 'Body\n', hasFrontmatter: true });
  const crlf = parseFrontmatter('---\r\nid: a\r\nkind: guide\r\n---\r\n\r\nBody\r\n');
  assert.deepEqual(crlf.data, { id: 'a', kind: 'guide' });
  assert.equal(crlf.body, 'Body\n');
});

test('a block that is never closed is body text, so one stray --- cannot swallow the whole document', () => {
  const raw = '---\nid: a\nnever closed\n';
  assert.deepEqual(parseFrontmatter(raw), { data: {}, body: raw, hasFrontmatter: false });
});

test('three dots close a block just as three dashes do', () => {
  assert.deepEqual(parseFrontmatter('---\nid: a\n...\nafter\n'), { data: { id: 'a' }, body: 'after\n', hasFrontmatter: true });
});

test('empty input and plain markdown have no front matter and keep their text', () => {
  assert.deepEqual(parseFrontmatter(''), { data: {}, body: '', hasFrontmatter: false });
  assert.deepEqual(parseFrontmatter('no front matter'), { data: {}, body: 'no front matter', hasFrontmatter: false });
  assert.deepEqual(parseFrontmatter(undefined), { data: {}, body: '', hasFrontmatter: false });
});

test('scalars: quotes protect a colon, inline lists split, numbers and booleans are typed, comments are dropped', () => {
  const raw = '---\nid: "quoted: yes"\ntags: [a, b, "c d"]\npin: true\nttlDays: 7\nverify: \'npm test\'\n# a comment line\nowner: pat # trailing comment\n---\n';
  assert.deepEqual(parseFrontmatter(raw).data, {
    id: 'quoted: yes',
    tags: ['a', 'b', 'c d'],
    pin: true,
    ttlDays: 7,
    verify: 'npm test',
    owner: 'pat',
  });
});

test('block lists work indented or flush-left, with quoted entries', () => {
  const raw = '---\ndescribes:\n  - src/**\n  - "lib/a.js"\nsupersedes:\n- old-doc\n---\nx';
  assert.deepEqual(parseFrontmatter(raw).data, { describes: ['src/**', 'lib/a.js'], supersedes: ['old-doc'] });
});

/* ---- writing ---- */

test('known fields come out in a fixed order and unknown fields are kept, sorted, after them', () => {
  const out = serializeFrontmatter({ id: 'a', kind: 'guide', custom: 'x', aaa: 'y' }, 'body');
  assert.equal(out, '---\nid: a\nkind: guide\naaa: y\ncustom: x\n---\n\nbody');
});

test('risky list items force the safe block form with quoting, and the result reads back the same', () => {
  const data = { id: 'a', tags: ['a', 'b: c'], describes: ['src/**', 'with space/*.md'] };
  const out = serializeFrontmatter(data, 'Body\n');
  assert.match(out, /tags:\n  - a\n  - 'b: c'/);
  const back = parseFrontmatter(out);
  assert.deepEqual(back.data, data);
  assert.equal(back.body, 'Body\n');
});

test('leading blank lines in the body are dropped so a rewrite does not keep adding spacing', () => {
  const once = serializeFrontmatter({ id: 'a' }, '\n\nbody');
  const twice = serializeFrontmatter(parseFrontmatter(once).data, parseFrontmatter(once).body);
  assert.equal(once, twice);
});

/* ---- checking ---- */

test('every kind of bad value is named with the fix', () => {
  const r = validateFrontmatter({ kontext: 1, id: 'Bad Id', kind: 'nope', pin: 'yes', ttlDays: 1.5, expires: '2026-13-45' });
  assert.equal(r.ok, false);
  const text = r.errors.join('\n');
  assert.match(text, /id: 'Bad Id' is not a valid slug .* try 'bad-id'/);
  assert.match(text, /kind: 'nope' is not a valid kind \(expected one of guide, decision, runbook, reference, handoff, index, spec\)/);
  assert.match(text, /expires: '2026-13-45' is not a valid date/);
  assert.match(text, /ttlDays: 1\.5 must be a positive whole number of days/);
  assert.match(text, /pin: 'yes' is not true or false/);
  assert.deepEqual(r.value, { kontext: 1 }, 'only what survived checking is returned');
});

test('a doc that opts in with kontext: needs an id; one that has not only gets a nudge', () => {
  const managed = validateFrontmatter({ kontext: 1 });
  assert.equal(managed.ok, false);
  assert.match(managed.errors[0], /id: missing \(every kontext doc needs a stable id/);
  const plain = validateFrontmatter({});
  assert.equal(plain.ok, true);
  assert.match(plain.warnings[0], /id: missing \(add one/);
});

test('mistakes that still work are warnings: a lone glob string, a lone tag, a newer spec', () => {
  const glob = validateFrontmatter({ id: 'ok', describes: 'src/**' });
  assert.equal(glob.ok, true);
  assert.deepEqual(glob.value.describes, ['src/**']);
  assert.match(glob.warnings[0], /wrap it in a list/);
  const tag = validateFrontmatter({ id: 'a', tags: 'solo' });
  assert.deepEqual(tag.value.tags, ['solo']);
  assert.match(tag.warnings.join(), /tags: 'solo' is a string/);
  assert.match(validateFrontmatter({ kontext: 9, id: 'ok' }).warnings[0], /spec version 9 is newer than this tool understands \(1\)/);
});

test('empty globs are flagged because staleness cannot be proven without one', () => {
  const r = validateFrontmatter({ id: 'ok', describes: [] });
  assert.match(r.warnings.join(), /empty list — staleness cannot be proven/);
  assert.match(validateFrontmatter({ id: 'ok', describes: ['a', ' '] }).warnings.join(), /empty entries were ignored/);
});

test('expires wins over ttlDays, and the doc is told so', () => {
  const r = validateFrontmatter({ id: 'a', expires: '2026-01-01', ttlDays: 3 });
  assert.equal(r.ok, true);
  assert.match(r.warnings.join(), /expires and ttlDays are both set; expires wins/);
});

test('a reference that can never match another doc is flagged', () => {
  assert.match(validateFrontmatter({ id: 'a', supersedes: ['Bad Ref'] }).warnings.join(), /supersedes: 'Bad Ref' is not a valid id slug/);
});

test('a typo on a known field is caught, because a misspelt describes silently turns staleness checks off', () => {
  assert.match(validateFrontmatter({ id: 'ok', describe: ['x'] }).warnings.join(), /describe: unknown field — did you mean 'describes'\?/);
  assert.match(validateFrontmatter({ id: 'ok', Owner: 'pat' }).warnings.join(), /did you mean 'owner'\?/);
  assert.deepEqual(validateFrontmatter({ id: 'ok', siteLayout: 'wide' }).warnings, [], 'unrelated keys from a site generator are fine');
});

test('wrong types say what they were given', () => {
  const r = validateFrontmatter({ id: 5, describes: 7, verify: 3, tags: { a: 1 } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('id:')));
  assert.ok(r.errors.some((e) => e.startsWith('describes:')));
  assert.ok(r.errors.some((e) => e.startsWith('verify:')));
  assert.ok(r.errors.some((e) => e.startsWith('tags:')));
});

test('something that is not a mapping at all is rejected outright', () => {
  for (const bad of [[], null, 'text']) {
    const r = validateFrontmatter(bad);
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /expected a mapping of keys to values/);
  }
});
