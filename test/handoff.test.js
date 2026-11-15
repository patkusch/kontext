import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderHandoffBody } from '../dist/commands/handoff.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

const repoState = (over = {}) => ({
  isRepo: true,
  branch: 'feature/login',
  head: 'abc1234',
  commits: [{ sha: 'abc1234', date: '2026-11-01T10:00:00Z', subject: 'start login work', author: 'pat' }],
  changed: [{ status: 'modified', path: 'src/auth.js' }],
  untracked: ['src/new.js'],
  ...over,
});

const report = (path, freshness, reasons = []) => ({ doc: { path }, freshness, reasons });

function body(over = {}) {
  return renderHandoffBody({
    task: 'Fix login',
    message: '',
    root: '/repo',
    state: repoState(),
    relevant: [],
    counts: { fresh: 1, stale: 1 },
    totalDocs: 2,
    ...over,
  });
}

test('the handoff names the task, the branch, the head commit and the recent commits', () => {
  const md = body();
  assert.match(md, /^# Handoff: feature\/login/);
  assert.match(md, /## The task\n\nFix login/);
  assert.match(md, /- Branch: `feature\/login`/);
  assert.match(md, /- HEAD: `abc1234`/);
  assert.match(md, /- `abc1234` start login work — pat, 2026-11-01/);
});

test('with no task it says so and tells the reader to confirm before changing anything', () => {
  assert.match(body({ task: '   ' }), /No task was recorded\. Infer it from the changed files below, and confirm before making changes\./);
});

test('uncommitted edits and new files are both listed, and a clean tree says so', () => {
  const dirty = body();
  assert.match(dirty, /1 tracked file\(s\) changed, 1 untracked/);
  assert.match(dirty, /- `src\/auth\.js` — modified/);
  assert.match(dirty, /- `src\/new\.js` — untracked \(new\)/);
  const clean = body({ state: repoState({ changed: [], untracked: [] }) });
  assert.match(clean, /_Working tree is clean\._/);
});

test('a long list of new files is cut at thirty and the rest are counted', () => {
  const many = Array.from({ length: 35 }, (_, i) => `tmp/file${i}.txt`);
  const md = body({ state: repoState({ untracked: many }) });
  assert.match(md, /file29\.txt/);
  assert.doesNotMatch(md, /file30\.txt/);
  assert.match(md, /\+5 more untracked/);
});

test('outside a git repository it says no branch or history was captured', () => {
  const md = body({ state: repoState({ isRepo: false, branch: null, head: null, commits: [], changed: [], untracked: [] }) });
  assert.match(md, /^# Handoff\n/);
  assert.match(md, /Not a git repository, so no branch or commit history was captured\./);
  assert.doesNotMatch(md, /Working tree/);
});

test('with no covering doc it flags the code as undocumented and points at kontext init', () => {
  const md = body({ relevant: [] });
  assert.match(md, /No doc in this repo declares `describes` globs matching the changed files\./);
  assert.match(md, /Run `kontext init`/);
  assert.match(md, /2\. Read the changed source files directly; no doc claims to describe them\./);
});

test('each covering doc shows why it is here, and the three reasons read differently', () => {
  const md = body({
    relevant: [
      { report: report('docs/a.md', 'fresh'), matched: ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js', 'src/e.js'], reason: 'covers-changed-files' },
      { report: report('docs/pin.md', 'fresh'), matched: [], reason: 'pinned' },
      { report: report('docs/task.md', 'unverified'), matched: [], reason: 'relevant-to-task' },
    ],
  });
  assert.match(md, /\| `docs\/a\.md` \| fresh \| covers `src\/a\.js`, `src\/b\.js`, `src\/c\.js` \+2 \|/);
  assert.match(md, /\| `docs\/pin\.md` \| fresh \| pinned — always relevant \|/);
  assert.match(md, /\| `docs\/task\.md` \| unverified \| lexically relevant to the task \|/);
});

test('a stale covering doc is called out with its reasons and is not recommended as the first read', () => {
  const md = body({
    relevant: [{ report: report('docs/old.md', 'stale', ['code changed 40 days after the doc', 'second reason', 'third reason', 'fourth reason']), matched: ['src/a.js'], reason: 'covers-changed-files' }],
  });
  assert.match(md, /### Do not trust these without re-reading the code/);
  assert.match(md, /- `docs\/old\.md` \(\*\*stale\*\*\)\n  - code changed 40 days after the doc/);
  assert.doesNotMatch(md, /fourth reason/, 'only the first three reasons are shown');
  assert.match(md, /nothing covering this work is provably fresh/);
});

test('a fresh covering doc is recommended as the first read', () => {
  const md = body({ relevant: [{ report: report('docs/ok.md', 'fresh'), matched: ['src/a.js'], reason: 'covers-changed-files' }] });
  assert.match(md, /2\. Read `docs\/ok\.md` — it is the freshest doc covering this code\./);
  assert.doesNotMatch(md, /Do not trust these/);
});

test('the freshness summary counts docs and leaves out verdicts with none', () => {
  const md = body({ counts: { fresh: 3, stale: 2, expired: 0 }, totalDocs: 5 });
  assert.match(md, /5 doc\(s\) total — 3 fresh · 2 stale\./);
  assert.doesNotMatch(md, /expired/);
  assert.match(body({ counts: {}, totalDocs: 0 }), /0 doc\(s\) total — no docs\./);
});

test('notes become one bullet per sentence or line; no notes says how to add them', () => {
  const md = body({ message: 'Check the retry path. Ask Sam about tokens?\nThe cache is flaky' });
  assert.match(md, /- Check the retry path\.\n- Ask Sam about tokens\?\n- The cache is flaky/);
  assert.match(body({ message: '' }), /_None recorded\. Re-run `kontext handoff --message "\.\.\."` to capture them\._/);
});

test('the handoff tells the reader it expires after seven days', () => {
  assert.match(body(), /expires 7 days after it was written/);
});

/* ---- the real command, in a real repo ---- */

function sh(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'kontext-handoff-'));
  sh(dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'src', 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'docs', 'login.md'), '---\nkontext: 1\nid: login\nkind: guide\ndescribes:\n  - src/a.js\n---\n# Login flow\n\nHow login works.\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'init');
  writeFileSync(join(dir, 'src', 'a.js'), 'export const a = 2;\n');
  writeFileSync(join(dir, 'src', 'new.js'), 'export const n = 1;\n');
  return dir;
}

const kontext = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

test('the command writes .kontext/handoff.md with the front matter that makes it expire', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = kontext(dir, 'handoff', '--task', 'fix login', '--message', 'Check retries');
  assert.equal(r.status, 0, r.stderr);
  const file = join(dir, '.kontext', 'handoff.md');
  assert.ok(existsSync(file));
  const md = readFileSync(file, 'utf8');
  assert.match(md, /^---\nkontext: 1\nid: handoff-main-\d{4}-\d{2}-\d{2}\nkind: handoff\n/);
  assert.match(md, /describes: \[src\/a\.js\]/);
  assert.match(md, /ttlDays: 7/);
  assert.match(md, /fix login/);
  assert.match(md, /- `src\/a\.js` — modified/);
  assert.match(md, /- `src\/new\.js` — untracked \(new\)/);
  assert.match(md, /\| `docs\/login\.md` \| fresh \| covers `src\/a\.js` \|/);
  assert.match(md, /- Check retries/);
  assert.match(r.stderr, /handoff captured \| 1 changed file\(s\) \| 1 relevant doc\(s\) \| expires in 7 days/);
});

test('--out writes to a chosen path, creating folders, and --json also prints the captured state', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = kontext(dir, 'handoff', '--out', 'notes/deep/h.md', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dir, 'notes', 'deep', 'h.md')));
  const state = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.equal(state.git.branch, 'main');
  assert.deepEqual(state.git.changed.map((c) => c.path), ['src/a.js']);
  assert.deepEqual(state.git.untracked, ['src/new.js']);
});

test('bad options are refused with exit code 2 and nothing is written', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = kontext(dir, 'handoff', '--nope');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option --nope/);
  assert.ok(!existsSync(join(dir, '.kontext', 'handoff.md')));
  const missing = kontext(dir, 'handoff', '--task');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--task expects a value/);
});
