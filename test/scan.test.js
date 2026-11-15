import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { readDoc, scanDocs, toRepoRelative } from '../dist/core/scan.js';
import { DEFAULT_CONFIG } from '../dist/types.js';

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kontext-scan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(dir, path, content) {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const scan = (dir, config = DEFAULT_CONFIG) => scanDocs(dir, config);
const paths = (docs) => docs.map((d) => d.path);

test('it finds markdown at any depth and returns it sorted, so output is the same on every machine', async (t) => {
  const dir = folder(t);
  put(dir, 'z.md', '# Z\n');
  put(dir, 'docs/b.md', '# B\n');
  put(dir, 'docs/deep/er/a.mdx', '# A\n');
  put(dir, 'docs/notes.txt', 'not markdown\n');
  assert.deepEqual(paths(await scan(dir)), ['docs/b.md', 'docs/deep/er/a.mdx', 'z.md']);
});

test('node_modules and .git are never walked, whatever the config says', async (t) => {
  const dir = folder(t);
  put(dir, 'docs/a.md', '# A\n');
  put(dir, 'node_modules/pkg/README.md', '# pkg\n');
  put(dir, '.git/notes.md', '# git\n');
  const everything = { ...DEFAULT_CONFIG, exclude: [] };
  assert.deepEqual(paths(await scan(dir, everything)), ['docs/a.md']);
});

test('the default excludes keep build output, changelogs and virtualenvs out', async (t) => {
  const dir = folder(t);
  put(dir, 'docs/a.md', '# A\n');
  put(dir, 'dist/out.md', '# out\n');
  put(dir, 'CHANGELOG.md', '# log\n');
  put(dir, '.venv/lib/LICENSE.md', '# licence\n');
  put(dir, 'coverage/report.md', '# cov\n');
  assert.deepEqual(paths(await scan(dir)), ['docs/a.md']);
});

test('include narrows what is read, and exclude removes from that', async (t) => {
  const dir = folder(t);
  put(dir, 'docs/a.md', '# A\n');
  put(dir, 'docs/drafts/b.md', '# B\n');
  put(dir, 'notes/c.md', '# C\n');
  const config = { ...DEFAULT_CONFIG, include: ['docs/**/*.md'], exclude: ['docs/drafts/**'] };
  assert.deepEqual(paths(await scan(dir, config)), ['docs/a.md']);
});

test('symbolic links are skipped, so a loop or a link out of the repo cannot be followed', async (t) => {
  const dir = folder(t);
  const outside = folder(t);
  put(dir, 'docs/a.md', '# A\n');
  put(outside, 'secret.md', '# outside\n');
  symlinkSync(outside, join(dir, 'linked-dir'));
  symlinkSync(join(outside, 'secret.md'), join(dir, 'linked.md'));
  symlinkSync(dir, join(dir, 'docs', 'loop'));
  assert.deepEqual(paths(await scan(dir)), ['docs/a.md']);
});

test('binary files and huge files are skipped without an error', async (t) => {
  const dir = folder(t);
  put(dir, 'ok.md', '# OK\n');
  put(dir, 'binary.md', `# Looks like text\n\u0000\u0001\u0002 binary`);
  put(dir, 'huge.md', `# Huge\n${'x'.repeat(2 * 1024 * 1024 + 10)}`);
  assert.deepEqual(paths(await scan(dir)), ['ok.md']);
});

test('a folder that does not exist gives an empty list, not an exception', async () => {
  assert.deepEqual(await scan(join(tmpdir(), 'kontext-does-not-exist-xyz')), []);
});

test('the title is the first top-level heading, else the first heading of any level, else the file name', async (t) => {
  const dir = folder(t);
  put(dir, 'a.md', '## Second level first\n\n# The real title\n');
  put(dir, 'b.md', '## Only a second level\n\ntext\n');
  put(dir, 'api-reference.md', 'no headings at all\n');
  put(dir, 'README.md', 'plain\n');
  const byPath = Object.fromEntries((await scan(dir)).map((d) => [d.path, d]));
  assert.equal(byPath['a.md'].title, 'The real title');
  assert.equal(byPath['b.md'].title, 'Only a second level');
  assert.equal(byPath['api-reference.md'].title, 'Api Reference');
  assert.equal(byPath['README.md'].title, 'README', 'all-caps words survive');
});

test('hash marks inside code fences are comments, not headings', async (t) => {
  const dir = folder(t);
  put(dir, 'a.md', '# Real\n\n```bash\n# install it\nnpm i\n```\n\n~~~\n# tilde fence\n~~~\n\n## Also real ##\n');
  const [d] = await scan(dir);
  assert.deepEqual(d.headings, ['Real', 'Also real']);
});

test('front matter is read, the body is separated from it, and bad values are dropped rather than trusted', async (t) => {
  const dir = folder(t);
  put(dir, 'a.md', '---\nkontext: 1\nid: Bad Id\nkind: guide\ndescribes:\n  - src/**\n---\n# Title\n\nSome words here.\n');
  put(dir, 'plain.md', '# Plain\n');
  const byPath = Object.fromEntries((await scan(dir)).map((d) => [d.path, d]));
  const a = byPath['a.md'];
  assert.equal(a.hasFrontmatter, true);
  assert.equal(a.frontmatter.kind, 'guide');
  assert.deepEqual(a.frontmatter.describes, ['src/**']);
  assert.equal(a.frontmatter.id, undefined, 'an invalid id is not carried through');
  assert.ok(a.body.startsWith('# Title'));
  assert.equal(byPath['plain.md'].hasFrontmatter, false);
});

test('word and token counts are filled in, and an empty body counts as zero', async (t) => {
  const dir = folder(t);
  put(dir, 'a.md', '# A\n\none two three four five\n');
  put(dir, 'empty.md', '---\nid: e\n---\n');
  const byPath = Object.fromEntries((await scan(dir)).map((d) => [d.path, d]));
  assert.equal(byPath['a.md'].wordCount, 7);
  assert.ok(byPath['a.md'].tokenEstimate > 0);
  assert.equal(byPath['empty.md'].wordCount, 0);
});

test('the content hash ignores spacing, so a reflowed copy matches but a changed word does not', async (t) => {
  const dir = folder(t);
  put(dir, 'a.md', '# A\n\nthe quick brown fox\n');
  put(dir, 'b.md', '# A\n\n\n   the   quick\nbrown     fox   \n');
  put(dir, 'c.md', '# A\n\nthe quick brown dog\n');
  const h = Object.fromEntries((await scan(dir)).map((d) => [d.path, d.contentHash]));
  assert.equal(h['a.md'], h['b.md']);
  assert.notEqual(h['a.md'], h['c.md']);
  assert.match(h['a.md'], /^[0-9a-f]{64}$/);
});

test('readDoc always returns a record: a missing file is an empty doc, not a throw', async (t) => {
  const dir = folder(t);
  put(dir, 'docs/a.md', '# A\n\ntext\n');
  const ok = await readDoc(dir, './docs/a.md');
  assert.equal(ok.path, 'docs/a.md', 'a leading ./ is removed');
  assert.equal(ok.title, 'A');
  const missing = await readDoc(dir, 'docs/gone.md');
  assert.equal(missing.path, 'docs/gone.md');
  assert.equal(missing.body, '');
  assert.equal(missing.hasFrontmatter, false);
  assert.equal(missing.title, 'Gone');
});

test('toRepoRelative turns an absolute path into the forward-slash form the rest of kontext uses', () => {
  assert.equal(toRepoRelative('/repo', '/repo/docs/a.md'), 'docs/a.md');
  assert.equal(toRepoRelative('/repo', '/repo/a.md'), 'a.md');
});
