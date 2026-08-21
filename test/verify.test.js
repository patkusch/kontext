import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanDocs } from '../dist/core/scan.js';
import { runVerify } from '../dist/core/freshness.js';
import { DEFAULT_CONFIG } from '../dist/types.js';

/** Regression tests for defects found while integrating the layers. */

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'kontext-verify-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 't@e.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 't@e.com',
  };
  execFileSync('git', ['init', '-q'], { cwd: dir, env });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
  return dir;
}

const docWith = (verify) => ({ frontmatter: { verify } });

test('verify runs through a shell, so builtins work', async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // `exit` is a shell builtin. Exec'ing it directly yields ENOENT, which reads
  // as "your verify command is broken" for a command that works in any terminal.
  const r = runVerify(dir, docWith('exit 7'));
  assert.ok(r, 'expected a VerifyResult');
  assert.equal(r.passed, false);
  assert.equal(r.exitCode, 7, `expected the real exit code, got ${r.exitCode}`);
  assert.doesNotMatch(r.output, /ENOENT/, 'a builtin must not surface as ENOENT');
});

test('verify supports pipes and && chains', async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'thing.txt'), 'hello\n');

  const ok = runVerify(dir, docWith('test -f thing.txt && echo yes | tr a-z A-Z'));
  assert.equal(ok.passed, true, `expected pass, got: ${JSON.stringify(ok)}`);
  assert.match(ok.output, /YES/);

  const bad = runVerify(dir, docWith('test -f nope.txt'));
  assert.equal(bad.passed, false);
});

test('verify reports a real exit code rather than throwing', async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.doesNotThrow(() => runVerify(dir, docWith('this-command-does-not-exist-xyz')));
  assert.equal(runVerify(dir, docWith('   ')), null, 'blank verify means no verify');
  assert.equal(runVerify(dir, { frontmatter: {} }), null);
});

test("kontext's own output is not part of the managed corpus", async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, 'README.md'), '# Repo\n');
  mkdirSync(join(dir, '.kontext'), { recursive: true });
  // A generated handoff carries ttlDays: 7. If kontext managed its own output,
  // running `handoff` would fail the repo's CI a week later, for no reason.
  writeFileSync(
    join(dir, '.kontext', 'handoff.md'),
    '---\nkontext: 1\nid: handoff\nkind: handoff\nttlDays: 7\n---\n\n# Handoff\n',
  );

  const docs = await scanDocs(dir, DEFAULT_CONFIG);
  const paths = docs.map((d) => d.path);
  assert.ok(paths.includes('README.md'), 'real docs are still scanned');
  assert.ok(
    !paths.some((p) => p.includes('.kontext/')),
    `.kontext/ must be excluded by default, got: ${paths.join(', ')}`,
  );
});

test('source files contain no raw control bytes', async () => {
  // Raw NUL/SOH bytes inside string literals make a .ts file read as binary to
  // git, grep, diff and GitHub's viewer. Use escape sequences instead.
  const files = execFileSync('git', ['ls-files', '*.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);

  const { readFileSync } = await import('node:fs');
  const root = new URL('..', import.meta.url).pathname;
  const offenders = files.filter((f) => {
    const buf = readFileSync(join(root, f));
    return buf.includes(0x00) || buf.includes(0x01);
  });
  assert.deepEqual(offenders, [], `raw control bytes in: ${offenders.join(', ')}`);
});

test('init refuses to write when the root resolved too wide', async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // A project folder with no .git of its own makes kontext walk up until it
  // finds one — which can land on the user's entire home directory. Writing
  // there would rewrite every markdown file they own.
  for (let i = 0; i < 420; i++) writeFileSync(join(dir, `d${i}.md`), `# Doc ${i}\n`);
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'many docs'], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.com',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.com',
    },
  });

  const cli = new URL('../dist/cli.js', import.meta.url).pathname;
  const run = (args) =>
    spawnSync(process.execPath, [cli, 'init', ...args], { cwd: dir, encoding: 'utf8' });

  const wrote = run(['--yes']);
  assert.equal(wrote.status, 2, 'a too-wide write must exit 2, not proceed');
  assert.match(wrote.stderr, /refusing to write/i);

  const before = readFileSync(join(dir, 'd0.md'), 'utf8');
  assert.equal(before, '# Doc 0\n', 'nothing may be written when the guard trips');

  // Previewing is harmless, so it warns rather than refusing.
  const preview = run(['--dry-run']);
  assert.equal(preview.status, 0, 'preview must still work');
  assert.match(preview.stderr, /wider than you probably meant/i);
});
