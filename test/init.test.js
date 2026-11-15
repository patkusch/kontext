import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSourceIndex, inferDescribes, inferId, inferKind, proposeFor, renderFrontmatterBlock } from '../dist/commands/init.js';

const doc = (path, { body = '', headings = [] } = {}) => ({ path, frontmatter: {}, hasFrontmatter: false, title: path, headings, body, wordCount: 1, tokenEstimate: 1, contentHash: path });

/* ---- ids ---- */

test('the id comes from the file name, lower-cased and with a number prefix dropped', () => {
  assert.equal(inferId('docs/Session Expiry.md', new Set()), 'session-expiry');
  assert.equal(inferId('docs/adr/0003-use-postgres.md', new Set()), 'use-postgres');
  assert.equal(inferId('docs/api_overview.mdx', new Set()), 'api-overview');
});

test('a README or index takes its folder name, so they do not all become "readme"', () => {
  assert.equal(inferId('docs/billing/README.md', new Set()), 'billing-readme');
  assert.equal(inferId('docs/billing/index.md', new Set()), 'billing-index');
  assert.equal(inferId('README.md', new Set()), 'readme');
});

test('a clash is settled by adding folder names, then a number as a last resort', () => {
  assert.equal(inferId('docs/auth/setup.md', new Set(['setup'])), 'auth-setup');
  assert.equal(inferId('docs/auth/setup.md', new Set(['setup', 'auth-setup'])), 'docs-auth-setup');
  assert.equal(inferId('setup.md', new Set(['setup'])), 'setup-2');
  assert.equal(inferId('setup.md', new Set(['setup', 'setup-2'])), 'setup-3');
  assert.equal(inferId('docs/---.md', new Set()), 'docs', 'a name with nothing usable in it falls back to the folder');
  assert.equal(inferId('---.md', new Set()), 'doc');
});

/* ---- kinds ---- */

test('the kind is read from the path first', () => {
  assert.equal(inferKind(doc('docs/handoff-2026.md')).kind, 'handoff');
  assert.equal(inferKind(doc('docs/adr/use-postgres.md')).kind, 'decision');
  assert.equal(inferKind(doc('docs/0007-cache-layer.md')).kind, 'decision');
  assert.equal(inferKind(doc('README.md')).kind, 'index');
  assert.equal(inferKind(doc('docs/runbooks/db-restore.md')).kind, 'runbook');
  assert.equal(inferKind(doc('docs/specs/auth.md')).kind, 'spec');
  assert.equal(inferKind(doc('docs/api/users.md')).kind, 'reference');
});

test('then from the headings, so the same words in a plain file name still count', () => {
  assert.equal(inferKind(doc('docs/x.md', { headings: ['Context', 'Decision', 'Consequences'] })).kind, 'decision');
  assert.equal(inferKind(doc('docs/x.md', { headings: ['Procedure', 'Rollback'] })).kind, 'runbook');
  assert.equal(inferKind(doc('docs/x.md', { headings: ['Requirements', 'Non-goals'] })).kind, 'spec');
  assert.equal(inferKind(doc('docs/x.md', { headings: ['Endpoints', 'Parameters'] })).kind, 'reference');
});

test('a doc that is mostly imperative steps reads as a runbook; anything else defaults to a guide, saying so', () => {
  const steps = '1. Run the migration\n2. Restart the worker\n3. Check the queue\n4. Verify the totals\n';
  assert.equal(inferKind(doc('docs/x.md', { body: steps })).kind, 'runbook');
  assert.match(inferKind(doc('docs/x.md', { body: steps })).why, /4 imperative list items/);
  const guide = inferKind(doc('docs/x.md', { body: 'Some thoughts about login.' }));
  assert.equal(guide.kind, 'guide');
  assert.match(guide.why, /defaulted/);
});

/* ---- describes ---- */

const files = ['src/auth/session.ts', 'src/auth/token.ts', 'src/auth/cookies.ts', 'src/db/pool.ts', 'lib/util.js', 'docs/readme.md', 'assets/logo.png', 'a/util.js'];

test('the source index keeps code files only and finds them by name or by the end of their path', () => {
  const idx = buildSourceIndex(files);
  assert.ok(idx.paths.has('src/auth/session.ts'));
  assert.ok(!idx.paths.has('docs/readme.md'), 'markdown is not source');
  assert.ok(!idx.paths.has('assets/logo.png'), 'images are not source');
  assert.deepEqual(idx.byBasename.get('util.js').sort(), ['a/util.js', 'lib/util.js']);
  assert.deepEqual(idx.bySuffix.get('auth/session.ts'), ['src/auth/session.ts']);
});

test('only mentions that resolve to a real file become claims; others are dropped', () => {
  const idx = buildSourceIndex(files);
  const r = inferDescribes(doc('docs/x.md', { body: 'See `src/db/pool.ts` and src/missing/ghost.ts and https://example.com/a/b.js.' }), idx);
  assert.deepEqual(r.globs, ['src/db/pool.ts']);
  assert.deepEqual(r.evidence, ['src/db/pool.ts']);
  assert.match(r.why, /1 file reference found/);
});

test('a doc citing code by its .js name finds the .ts file, and a loose file name resolves when it is unique', () => {
  const idx = buildSourceIndex(files);
  assert.deepEqual(inferDescribes(doc('d.md', { body: 'It lives in ./src/auth/session.js' }), idx).globs, ['src/auth/session.ts']);
  assert.deepEqual(inferDescribes(doc('d.md', { body: 'Uses `pool.ts` for connections.' }), idx).globs, ['src/db/pool.ts']);
});

test('an ambiguous name is not guessed: two files called util.js means no claim', () => {
  const idx = buildSourceIndex(files);
  const r = inferDescribes(doc('d.md', { body: 'See `util.js`.' }), idx);
  assert.deepEqual(r.globs, []);
  assert.match(r.why, /no resolvable source-file references/);
});

test('three or more files from one folder collapse into a folder glob', () => {
  const idx = buildSourceIndex(files);
  const body = 'Read src/auth/session.ts, src/auth/token.ts and src/auth/cookies.ts. Also src/db/pool.ts.';
  const r = inferDescribes(doc('d.md', { body }), idx);
  assert.deepEqual(r.globs, ['src/auth/**', 'src/db/pool.ts']);
  assert.equal(r.evidence.length, 4);
});

test('imports in code blocks count as mentions', () => {
  const idx = buildSourceIndex(files);
  const r = inferDescribes(doc('d.md', { body: "```js\nimport { x } from 'src/db/pool.ts';\n```" }), idx);
  assert.deepEqual(r.globs, ['src/db/pool.ts']);
});

/* ---- proposals ---- */

test('a proposal carries id, kind, claims and an honest confidence level', () => {
  const idx = buildSourceIndex(files);
  const high = proposeFor(doc('docs/auth.md', { body: 'src/auth/session.ts src/auth/token.ts src/auth/cookies.ts' }), idx, new Set());
  assert.equal(high.frontmatter.id, 'auth');
  assert.equal(high.frontmatter.kontext, 1);
  assert.deepEqual(high.frontmatter.describes, ['src/auth/**']);
  assert.equal(high.confidence, 'high');

  const medium = proposeFor(doc('docs/db.md', { body: 'src/db/pool.ts' }), idx, new Set());
  assert.equal(medium.confidence, 'medium');

  const low = proposeFor(doc('docs/thoughts.md', { body: 'Nothing about code.' }), idx, new Set());
  assert.equal(low.confidence, 'low');
  assert.equal(low.frontmatter.describes, undefined);
});

test('a handoff doc is given a seven-day life', () => {
  const p = proposeFor(doc('docs/handoff.md'), buildSourceIndex([]), new Set());
  assert.equal(p.frontmatter.kind, 'handoff');
  assert.equal(p.frontmatter.ttlDays, 7);
});

test('the written block has a review comment inside the front matter that says why each field was chosen', () => {
  const p = proposeFor(doc('docs/db.md', { body: 'src/db/pool.ts' }), buildSourceIndex(files), new Set());
  const block = renderFrontmatterBlock(p, '# DB\n');
  assert.match(block, /^---\n# INFERRED by `kontext init` — review before trusting\n/);
  assert.match(block, /# id: from the filename/);
  assert.match(block, /# kind: /);
  assert.match(block, /# describes: 1 file reference found/);
  assert.match(block, /\nid: db\n/);
});

/* ---- the real command ---- */

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const kontext = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'kontext-init-'));
  const sh = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, stdio: 'pipe' });
  sh('init', '-q');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'src', 'pool.ts'), 'export const pool = 1;\n');
  writeFileSync(join(dir, 'docs', 'db.md'), '# Database\n\nConnections come from `src/pool.ts`.\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'init');
  return dir;
}

test('init without --yes shows what it would do and writes nothing', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = readFileSync(join(dir, 'docs', 'db.md'), 'utf8');
  const r = kontext(dir, 'init');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, 'docs', 'db.md'), 'utf8'), before);
  assert.ok(!existsSync(join(dir, 'kontext.config.json')));
});

test('init --json lists the proposals without writing', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = kontext(dir, 'init', '--json');
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  const list = data.proposals ?? data;
  assert.ok(JSON.stringify(list).includes('docs/db.md'));
  assert.ok(JSON.stringify(list).includes('src/pool.ts'));
});

test('init --yes writes front matter, keeps the body byte for byte, and the claim is recorded', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const body = '# Database\n\nConnections come from `src/pool.ts`.\n';
  const r = kontext(dir, 'init', '--yes');
  assert.equal(r.status, 0, r.stderr);
  const after = readFileSync(join(dir, 'docs', 'db.md'), 'utf8');
  assert.ok(after.startsWith('---\n'));
  assert.ok(after.endsWith(body), 'the original body is preserved exactly');
  assert.match(after, /id: db\n/);
  assert.match(after, /describes: \[src\/pool\.ts\]/);
  assert.match(after, /INFERRED by `kontext init`/);
});

test('--dry-run never writes, even with --yes', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = readFileSync(join(dir, 'docs', 'db.md'), 'utf8');
  const r = kontext(dir, 'init', '--yes', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, 'docs', 'db.md'), 'utf8'), before);
});
