import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// End to end: the real command line against a small throw-away repo with three
// docs: one fresh, one stale (its code changed after it) and one with no front matter.

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
let dir;

function git(cwd, date, ...args) {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    stdio: 'pipe',
  });
}

function doc(id, kind, title, glob, body) {
  return `---\nkontext: 1\nid: ${id}\nkind: ${kind}\ndescribes:\n  - ${glob}\n---\n# ${title}\n\n${body}\n`;
}

function kontext(cwd, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'kontext-cmds-'));
  git(dir, '2025-01-01T00:00:00Z', 'init', '-q');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'src', 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'src', 'b.js'), 'export const b = 1;\n');
  writeFileSync(join(dir, 'docs', 'login.md'), doc('login', 'guide', 'Login flow', 'src/a.js', 'How login sessions work.'));
  writeFileSync(join(dir, 'docs', 'billing.md'), doc('billing', 'runbook', 'Billing runbook', 'src/b.js', 'How billing retries work.'));
  writeFileSync(join(dir, 'docs', 'notes.md'), '# Loose notes\n\nSome notes about login.\n');
  git(dir, '2025-01-01T00:00:00Z', 'add', '-A');
  git(dir, '2025-01-01T00:00:00Z', 'commit', '-q', '-m', 'init');
  writeFileSync(join(dir, 'src', 'b.js'), 'export const b = 2;\n');
  git(dir, '2025-06-01T00:00:00Z', 'commit', '-q', '-am', 'change billing code');
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('map counts every doc and sorts each into a verdict', () => {
  const r = kontext(dir, 'map', '--json');
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(r.stdout);
  assert.equal(m.totals.docs, 3);
  assert.deepEqual(
    { fresh: m.totals.counts.fresh, stale: m.totals.counts.stale, unverified: m.totals.counts.unverified },
    { fresh: 1, stale: 1, unverified: 1 },
  );
  const byPath = Object.fromEntries(m.groups.flatMap((g) => g.entries).map((e) => [e.path, e]));
  assert.equal(byPath['docs/login.md'].freshness, 'fresh');
  assert.equal(byPath['docs/billing.md'].freshness, 'stale');
  assert.equal(byPath['docs/notes.md'].freshness, 'unverified');
  assert.deepEqual(byPath['docs/billing.md'].describes, ['src/b.js']);
});

test('map can group by kind, by verdict, or by folder, and refuses anything else', () => {
  const kinds = JSON.parse(kontext(dir, 'map', '--by', 'kind', '--json').stdout);
  assert.equal(kinds.groupedBy, 'kind');
  assert.deepEqual(kinds.groups.map((g) => g.key).sort(), ['guide', 'runbook', 'unclassified']);
  const verdicts = JSON.parse(kontext(dir, 'map', '--by', 'freshness', '--json').stdout);
  assert.deepEqual(verdicts.groups.map((g) => g.key).sort(), ['fresh', 'stale', 'unverified']);
  const bad = kontext(dir, 'map', '--by', 'nonsense');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--by expects one of kind, freshness, dir/);
});

test('map prints a readable tree and a legend when it is not asked for JSON', () => {
  const r = kontext(dir, 'map');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /kontext map \| grouped by dir/);
  assert.match(r.stdout, /billing\.md\s+runbook\s+~\d+\s+stale/);
  assert.match(r.stdout, /3 docs/);
  assert.match(r.stdout, /33% unverified/);
});

test('pack puts the fresh, relevant doc in and says how many tokens it used', () => {
  const p = JSON.parse(kontext(dir, 'pack', 'login', '--json').stdout);
  assert.equal(p.task, 'login');
  assert.equal(p.budget, 8000);
  assert.equal(p.entries[0].path, 'docs/login.md');
  assert.equal(p.entries[0].freshness, 'fresh');
  assert.ok(p.entries[0].relevance > p.entries[1].relevance, 'the doc about login outranks the loose notes');
  assert.equal(p.tokensUsed, p.entries.reduce((n, e) => n + e.tokens, 0));
});

test('pack keeps a stale doc out and names it, unless told to include it', () => {
  const kept = JSON.parse(kontext(dir, 'pack', 'billing', '--json').stdout);
  assert.deepEqual(kept.entries, []);
  assert.deepEqual(kept.excludedForStaleness.map((e) => [e.path, e.freshness]), [['docs/billing.md', 'stale']]);
  const text = kontext(dir, 'pack', 'billing');
  assert.match(text.stderr, /excluded because they are not trustworthy/);
  assert.match(text.stderr, /use --include-stale/);

  const all = JSON.parse(kontext(dir, 'pack', 'billing', '--include-stale', '--json').stdout);
  assert.deepEqual(all.entries.map((e) => e.path), ['docs/billing.md']);
  assert.deepEqual(all.excludedForStaleness, []);
});

test('pack respects a small budget and says what it left out and what budget would fit it', () => {
  const p = JSON.parse(kontext(dir, 'pack', 'login', '--budget', '12', '--json').stdout);
  assert.ok(p.tokensUsed <= 12);
  assert.deepEqual(p.omitted.map((o) => o.path), ['docs/notes.md']);
  assert.match(p.omitted[0].reason, /only .* of the 12-token budget remained/);
});

test('pack can write to a file instead of the screen, as markdown', () => {
  const out = join(dir, 'pack.md');
  const r = kontext(dir, 'pack', 'login', '--out', out);
  assert.equal(r.status, 0, r.stderr);
  const md = readFileSync(out, 'utf8');
  assert.match(md, /^# Context pack: login/);
  assert.match(md, /Generated by kontext/);
  assert.match(md, /How login sessions work\./);
});

test('pack with no task, a mistyped command, or a bad flag value is refused with exit code 2', () => {
  const none = kontext(dir, 'pack');
  assert.equal(none.status, 2);
  assert.match(none.stderr, /pack needs a task description/);
  const typo = kontext(dir, 'chek');
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /unknown command: chek/);
  assert.match(typo.stderr, /did you mean check\?/);
  const bad = kontext(dir, 'pack', 'login', '--budget', 'lots');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--budget expects a number/);
});

test('--version and --help work from any folder', () => {
  assert.match(kontext(dir, '--version').stdout, /^\d+\.\d+\.\d+\s*$/);
  const help = kontext(dir, '--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage/);
});

test('a folder with no markdown is reported plainly, not as a crash', () => {
  const empty = mkdtempSync(join(tmpdir(), 'kontext-empty-'));
  try {
    const r = kontext(empty, 'map');
    assert.equal(r.status, 0);
    assert.match(r.stdout + r.stderr, /no markdown matched/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
