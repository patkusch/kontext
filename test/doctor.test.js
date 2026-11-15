import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kontext-doctor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(dir, path, content) {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function git(dir, date, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    stdio: 'pipe',
  });
}

function commitAll(dir, date, message = 'work') {
  git(dir, date, 'add', '-A');
  git(dir, date, 'commit', '-q', '-m', message);
}

function initRepo(dir) {
  git(dir, '2025-01-01T00:00:00Z', 'init', '-q');
}

const claimed = (id, glob, extra = '') => `---\nkontext: 1\nid: ${id}\nkind: guide\ndescribes:\n  - ${glob}\n${extra}---\n# ${id}\n\nText about ${id}.\n`;

function doctor(dir, ...args) {
  const r = spawnSync(process.execPath, [CLI, 'doctor', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const report = (dir) => JSON.parse(doctor(dir, '--json').stdout);
const titles = (r) => r.findings.map((f) => f.title);

test('outside a git repository the first thing it says is that history cannot be used, and it exits 1', (t) => {
  const dir = folder(t);
  put(dir, 'docs/a.md', '# A\n\ntext\n');
  const r = doctor(dir, '--json');
  const data = JSON.parse(r.stdout);
  assert.equal(r.status, 1);
  assert.equal(data.exitCode, 1);
  assert.equal(data.git.isRepo, false);
  assert.equal(data.findings[0].severity, 'blocker');
  assert.equal(data.findings[0].title, 'not a git repository');
  assert.match(data.findings[0].fix, /Run `git init` and commit/);
});

test('a repository with no commits is a blocker too', (t) => {
  const dir = folder(t);
  initRepo(dir);
  put(dir, 'docs/a.md', '# A\n\ntext\n');
  const data = report(dir);
  assert.ok(titles(data).includes('git repo has no commits'), titles(data).join('\n'));
  assert.equal(data.exitCode, 1);
});

test('no markdown at all names the patterns it looked for', (t) => {
  const dir = folder(t);
  initRepo(dir);
  put(dir, 'src/a.js', 'x\n');
  commitAll(dir, '2025-01-01T00:00:00Z');
  const data = report(dir);
  const finding = data.findings.find((f) => f.title === 'no markdown files matched');
  assert.ok(finding);
  assert.equal(finding.severity, 'blocker');
  assert.match(finding.fix, /Nothing matched \*\*\/\*\.md, \*\*\/\*\.mdx/);
  assert.equal(data.corpus.docs, 0);
});

test('a healthy repo gets one reassuring line and exit code 0', (t) => {
  const dir = folder(t);
  initRepo(dir);
  put(dir, 'src/a.js', 'export const a = 1;\n');
  put(dir, 'docs/a.md', claimed('a', 'src/a.js', 'verify: node --version\n'));
  put(dir, 'kontext.config.json', '{}\n');
  commitAll(dir, '2025-01-01T00:00:00Z');
  const data = report(dir);
  assert.deepEqual(data.findings.map((f) => f.severity), ['ok']);
  assert.match(data.findings[0].title, /^nothing to fix/);
  assert.equal(data.exitCode, 0);
  assert.equal(data.config.exists, true);
  assert.equal(data.corpus.withVerify, 1);
});

test('when no doc claims any code, that is the big finding, and init is the fix', (t) => {
  const dir = folder(t);
  initRepo(dir);
  put(dir, 'docs/a.md', '# A\n\ntext\n');
  put(dir, 'docs/b.md', '# B\n\ntext\n');
  commitAll(dir, '2025-01-01T00:00:00Z');
  const data = report(dir);
  const f = data.findings.find((x) => x.title.startsWith('0 of 2 docs declare `describes`'));
  assert.ok(f, titles(data).join('\n'));
  assert.equal(f.severity, 'major');
  assert.match(f.fix, /kontext init/);
  assert.equal(data.corpus.unprovablePct, 100);
});

test('when only some docs have no claim, it is minor if under half and major if over half', (t) => {
  const minor = folder(t);
  initRepo(minor);
  put(minor, 'src/a.js', 'x\n');
  put(minor, 'docs/a.md', claimed('a', 'src/a.js'));
  put(minor, 'docs/b.md', claimed('b', 'src/a.js'));
  put(minor, 'docs/c.md', '# C\n\ntext\n');
  commitAll(minor, '2025-01-01T00:00:00Z');
  const m = report(minor).findings.find((f) => /have no `describes` claim/.test(f.title));
  assert.equal(m.severity, 'minor');
  assert.match(m.title, /^1 of 3 docs \(33%\)/);

  const major = folder(t);
  initRepo(major);
  put(major, 'src/a.js', 'x\n');
  put(major, 'docs/a.md', claimed('a', 'src/a.js'));
  put(major, 'docs/b.md', '# B\n\ntext\n');
  put(major, 'docs/c.md', '# C\n\ntext\n');
  commitAll(major, '2025-01-01T00:00:00Z');
  const j = report(major).findings.find((f) => /have no `describes` claim/.test(f.title));
  assert.equal(j.severity, 'major');
});

test('duplicate ids and conflicting claims are both major, with the ids and counts named', (t) => {
  const dir = folder(t);
  initRepo(dir);
  put(dir, 'src/a.js', 'x\n');
  put(dir, 'docs/one.md', claimed('same', 'src/a.js').replace('Text about same.', 'PORT=8080'));
  put(dir, 'docs/two.md', claimed('same', 'src/a.js').replace('Text about same.', 'PORT=3000'));
  commitAll(dir, '2025-01-01T00:00:00Z');
  const data = report(dir);
  const dup = data.findings.find((f) => f.title.startsWith('1 duplicate doc id(s): same'));
  assert.ok(dup, titles(data).join('\n'));
  assert.equal(dup.severity, 'major');
  const conflict = data.findings.find((f) => /conflict\(s\) between docs/.test(f.title));
  assert.ok(conflict);
  assert.equal(conflict.severity, 'major');
  assert.ok(data.conflicts.length >= 1);
  assert.ok(Object.keys(data.duplicateIds).includes('same'));
});

test('a stale doc is minor while it is under a third of the corpus and major above that', (t) => {
  const dir = folder(t);
  initRepo(dir);
  put(dir, 'src/a.js', 'v1\n');
  put(dir, 'src/b.js', 'v1\n');
  put(dir, 'src/c.js', 'v1\n');
  put(dir, 'docs/a.md', claimed('a', 'src/a.js'));
  put(dir, 'docs/b.md', claimed('b', 'src/b.js'));
  put(dir, 'docs/c.md', claimed('c', 'src/c.js'));
  commitAll(dir, '2025-01-01T00:00:00Z');
  put(dir, 'src/a.js', 'v2\n');
  commitAll(dir, '2025-06-01T00:00:00Z', 'change a');
  const one = report(dir).findings.find((f) => /are drifting, stale/.test(f.title));
  assert.equal(one.title, '1 doc(s) are drifting, stale, expired, orphaned or superseded');
  assert.equal(one.severity, 'minor');

  put(dir, 'src/b.js', 'v2\n');
  commitAll(dir, '2025-06-02T00:00:00Z', 'change b');
  const two = report(dir).findings.find((f) => /are drifting, stale/.test(f.title));
  assert.equal(two.severity, 'major');
});

test('findings are listed worst first, and the text report numbers them under "fix these, in this order"', (t) => {
  const dir = folder(t);
  initRepo(dir);
  put(dir, 'docs/a.md', '# A\n\ntext\n');
  commitAll(dir, '2025-01-01T00:00:00Z');
  const data = report(dir);
  const order = ['blocker', 'major', 'minor', 'ok'];
  const ranks = data.findings.map((f) => order.indexOf(f.severity));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  const text = doctor(dir);
  assert.match(text.stdout, /fix these, in this order/);
  assert.match(text.stdout, /\n\s+1\. (major|minor)\s/);
  assert.match(text.stdout, /with `describes`\s+0\/1/);
  assert.match(text.stdout, /duplicate ids\s+0/);
});

test('--json reports the corpus numbers that the text view is built from', (t) => {
  const dir = folder(t);
  initRepo(dir);
  put(dir, 'src/a.js', 'x\n');
  put(dir, 'docs/a.md', claimed('a', 'src/a.js'));
  put(dir, 'docs/plain.md', '# Plain\n\ntext\n');
  commitAll(dir, '2025-01-01T00:00:00Z');
  const { corpus, git: g, config } = report(dir);
  assert.equal(corpus.docs, 2);
  assert.equal(corpus.withFrontmatter, 1);
  assert.equal(corpus.withDescribes, 1);
  assert.equal(corpus.unprovable, 1);
  assert.deepEqual(g, { isRepo: true, commits: 1 });
  assert.deepEqual(config.include, ['**/*.md', '**/*.mdx']);
  assert.ok(config.failOn.includes('stale'));
});
