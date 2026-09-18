import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { lastCommitForPath, commitsTouchingSince } from '../dist/core/git.js';

/**
 * Evidence for the `--follow` decision recorded in `src/core/git.ts`.
 *
 * This is not a hypothetical: it builds a real repo where a file is renamed
 * partway through its history, with real content changes on both sides of
 * the rename (a single-line diff falls under git's default 50% similarity
 * threshold and is never detected as a rename at all, so the fixture has to
 * be realistic or the experiment proves nothing). It then runs kontext's
 * actual evidence functions against it, and separately probes what `git log
 * --follow` would do if wired in, so the tradeoff in the code comment is
 * something a future reader can rerun rather than take on faith.
 */

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function commitAt(cwd, message, isoDate) {
  git(cwd, 'add', '-A');
  execFileSync('git', ['commit', '-q', '-m', message], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate,
    },
  });
}

/**
 * A file with enough shared content that git's default -M50 similarity
 * detects the move as a rename rather than a delete+add. Each revision
 * changes only a line or two, same as a real refactor would.
 */
function sessionSource(revision) {
  const lines = [
    'function createSession(user) {',
    `  return { id: user.id, token: makeToken()${revision >= 2 ? ', createdAt: Date.now()' : ''} };`,
    '}',
    '',
    'function makeToken() {',
    "  return Math.random().toString(36);",
    '}',
    '',
    'function validateSession(session) {',
    revision >= 3
      ? '  return Boolean(session && session.token);'
      : '  return session && session.token;',
    '}',
    '',
    ...(revision >= 4 ? ['function isExpired(session) {', '  return false;', '}', ''] : []),
    'module.exports = { createSession, validateSession };',
    '',
  ];
  return lines.join('\n');
}

function makeRenamedRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'kontext-git-rename-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');

  mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
  writeFileSync(join(dir, 'src', 'auth', 'session.js'), sessionSource(1));
  commitAt(dir, 'add session.js v1', '2025-01-01T00:00:00Z');

  writeFileSync(join(dir, 'src', 'auth', 'session.js'), sessionSource(2));
  commitAt(dir, 'session.js v2: add createdAt', '2025-02-01T00:00:00Z');

  mkdirSync(join(dir, 'src', 'identity'), { recursive: true });
  git(dir, 'mv', 'src/auth/session.js', 'src/identity/session.js');
  writeFileSync(join(dir, 'src', 'identity', 'session.js'), sessionSource(3));
  commitAt(dir, 'move session.js to identity module', '2025-03-01T00:00:00Z');

  writeFileSync(join(dir, 'src', 'identity', 'session.js'), sessionSource(4));
  commitAt(dir, 'session.js v4 post-rename fix', '2025-04-01T00:00:00Z');

  return dir;
}

test('git itself detects the fixture rename with -M (sanity check on the fixture)', (t) => {
  const dir = makeRenamedRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const stat = git(dir, 'log', '-1', '-M', '--stat', '--pretty=format:', 'HEAD~1');
  assert.match(
    stat,
    /session\.js/,
    'expected the rename commit stat to mention session.js',
  );
  assert.match(
    stat,
    /\{auth => identity\}/,
    'git should report this as a rename (auth => identity), not a delete+add — ' +
      'otherwise the fixture is not testing what this file claims it tests',
  );
});

test('without --follow, kontext undercounts commits across a rename (the current, accepted cost)', (t) => {
  const dir = makeRenamedRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Four commits touched this file's lineage: v1, v2 (as src/auth/session.js),
  // the rename+edit, and v4 (as src/identity/session.js). Querying kontext's
  // real evidence function against the current path only sees the two commits
  // that happened after the rename — the pre-rename history is invisible.
  const sinceEverything = '2025-01-01T00:00:00Z';
  const currentPathOnly = commitsTouchingSince(
    dir,
    ['src/identity/session.js'],
    sinceEverything,
  );
  assert.equal(
    currentPathOnly.count,
    2,
    'current behavior: only post-rename commits are counted against the new path',
  );

  // The full picture is recoverable today only by also asking about the old
  // path — which requires already knowing the file was renamed and to what.
  const oldPathOnly = commitsTouchingSince(dir, ['src/auth/session.js'], sinceEverything);
  assert.equal(oldPathOnly.count, 3, 'the old path carries the pre-rename commits');

  // lastCommitForPath is unaffected by this gap: the newest commit always
  // touches the file under its current name, rename or not.
  const last = lastCommitForPath(dir, 'src/identity/session.js');
  assert.equal(last?.subject, 'session.js v4 post-rename fix');
});

test('--follow requires exactly one pathspec, so it cannot serve a describes: [globs] list', (t) => {
  const dir = makeRenamedRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // This is the hard constraint that rules --follow out for kontext's actual
  // call shape: every function in git.ts takes an array of resolved paths
  // (a `describes` glob commonly matches more than one file), and batches
  // them into a single `git log -- pathA pathB ...` invocation. --follow
  // does not support that.
  assert.throws(
    () =>
      execFileSync(
        'git',
        ['log', '--follow', '--name-only', '--', 'src/identity/session.js', 'src/auth/session.js'],
        { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    /--follow requires exactly one pathspec/,
  );
});

test('experiment: --follow -M does bridge the rename for a single resolved path', (t) => {
  const dir = makeRenamedRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // This proves --follow's benefit is real, not just a documented claim: for
  // the narrow case of a single-file path (no glob fan-out), it does what
  // the name promises. It is not wired into src/core/git.ts — see the
  // decision recorded there — but the mechanism itself works as advertised.
  const out = git(
    dir,
    'log',
    '--follow',
    '-M',
    '--name-only',
    '--pretty=format:>>%H|%s',
    '--',
    'src/identity/session.js',
  );
  const subjects = [...out.matchAll(/>>[0-9a-f]+\|([^\n]+)/g)].map((m) => m[1]);
  assert.deepEqual(
    subjects,
    [
      'session.js v4 post-rename fix',
      'move session.js to identity module',
      'session.js v2: add createdAt',
      'add session.js v1',
    ],
    '--follow -M walks across the rename and recovers all four commits, in order',
  );

  // But note the cost that would show up in kontext's output shape: the
  // recovered file list mixes the file's old and new names, and the old
  // name no longer exists in the working tree. kontext's `files` evidence
  // (see commitsTouchingSince) is documented as a sample of *tracked*
  // files; silently mixing in a since-renamed path would break that
  // contract for exactly the docs where it fired.
  assert.match(out, /src\/auth\/session\.js/, 'the old path appears in --follow output');
  assert.match(out, /src\/identity\/session\.js/, 'as does the new path');
});

/* ------------------------------------------------------------------------ *
 * Glob-level relocation: a doc's whole subject folder moves.
 *
 * Everything above is about one file's history. This half is the other
 * problem: `describes: src/auth/**` and the team moves the folder to
 * `src/identity/**`. The glob then matches nothing. kontext's job is to say
 * where the files went, when git can prove it, and to say "cannot tell" when
 * it cannot. Every fixture here is a real repo; nothing is mocked.
 * ------------------------------------------------------------------------ */

import { spawnSync } from 'node:child_process';
import { renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { findRelocation, listTrackedFiles } from '../dist/core/git.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const NAMES = ['session', 'token', 'cookies', 'csrf'];

/** 16 distinct lines per file, so a small edit stays far above git's 50% bar. */
function moduleSource(name, edit = '') {
  const lines = [`// ${name} module`];
  for (let i = 1; i <= 14; i += 1) lines.push(`export function ${name}Fn${i}(x) { return x + ${i}; }`);
  if (edit) lines.push(edit);
  return `${lines.join('\n')}\n`;
}

/** A total rewrite: nothing in common with moduleSource, so git sees delete + add. */
function rewrittenSource(name) {
  const lines = [`# entirely different ${name}`];
  for (let i = 1; i <= 14; i += 1) lines.push(`const ${name}Value${i} = new Map([['k${i}', "${name}-${i * 7919}"]]);`);
  return `${lines.join('\n')}\n`;
}

function docSource(describes) {
  const list = describes.map((g) => `  - ${g}`).join('\n');
  return `---\nkontext: 1\nid: auth-flow\nkind: guide\ndescribes:\n${list}\n---\n# Auth flow\n\nHow sessions work.\n`;
}

/** Four files under src/auth and a doc that describes them, with real history. */
function makeFolderRepo(describes = ['src/auth/**']) {
  const dir = mkdtempSync(join(tmpdir(), 'kontext-reloc-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  for (const name of NAMES) writeFileSync(join(dir, 'src', 'auth', `${name}.js`), moduleSource(name));
  writeFileSync(join(dir, 'docs', 'auth.md'), docSource(describes));
  commitAt(dir, 'initial: code and doc together', '2025-01-01T00:00:00Z');
  writeFileSync(join(dir, 'src', 'auth', 'session.js'), moduleSource('session', '// tweak'));
  commitAt(dir, 'session tweak', '2025-02-01T00:00:00Z');
  return dir;
}

/** `git mv src/auth src/identity` plus a one-line edit to each moved file. */
function moveFolder(dir, { to = 'identity', names = NAMES } = {}) {
  mkdirSync(join(dir, 'src', to), { recursive: true });
  for (const name of names) {
    git(dir, 'mv', `src/auth/${name}.js`, `src/${to}/${name}.js`);
    writeFileSync(join(dir, 'src', to, `${name}.js`), moduleSource(name, '// moved'));
  }
}

function kontext(dir, ...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function checkDoc(dir) {
  const result = kontext(dir, 'check', '--json');
  return JSON.parse(result.stdout).docs.find((d) => d.path === 'docs/auth.md');
}

test('relocation: a whole folder moved with small edits is found, and the doc is told the new glob', (t) => {
  const dir = makeFolderRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  moveFolder(dir);
  commitAt(dir, 'move auth to identity', '2025-03-01T00:00:00Z');

  const doc = checkDoc(dir);
  // The verdict is unchanged: the glob as written still matches nothing, so
  // the doc is still orphaned and CI still fails until someone edits it.
  assert.equal(doc.freshness, 'orphaned');
  assert.deepEqual(doc.drift.missingGlobs, ['src/auth/**']);

  const [relocation] = doc.drift.relocations;
  assert.equal(relocation.glob, 'src/auth/**');
  assert.equal(relocation.suggestedGlob, 'src/identity/**');
  assert.equal(relocation.fileCount, 4);
  assert.equal(relocation.movedCount, 4);
  assert.equal(relocation.extraMatches, 0);
  assert.equal(relocation.leftIn.subject, 'move auth to identity');
  assert.ok(relocation.lowestSimilarity >= 90, 'one added line in ~16 is a near-identical file');

  const finding = doc.reasons.find((r) => r.includes('used to match'));
  assert.match(finding, /`src\/auth\/\*\*` matches nothing now, but it used to match 4 files/);
  assert.match(finding, /4 of 4 now appear at `src\/identity\/\*\*`/);
  assert.match(finding, /Update `describes` to `src\/identity\/\*\*`/);
  assert.match(doc.hint, /from `src\/auth\/\*\*` to `src\/identity\/\*\*`/);

  // doctor raises it as its own finding instead of burying it in "N docs are orphaned".
  const doctor = JSON.parse(kontext(dir, 'doctor', '--json').stdout);
  assert.ok(doctor.findings.some((f) => /describe code that has moved/.test(f.title)));
});

test('relocation: some files moved, one deleted, is still reported with the honest count', (t) => {
  const dir = makeFolderRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  moveFolder(dir, { names: ['session', 'token', 'cookies'] });
  git(dir, 'rm', '-q', 'src/auth/csrf.js');
  commitAt(dir, 'move most of auth, drop csrf', '2025-03-01T00:00:00Z');

  const [relocation] = checkDoc(dir).drift.relocations;
  assert.equal(relocation.suggestedGlob, 'src/identity/**');
  assert.equal(relocation.fileCount, 4);
  assert.equal(relocation.movedCount, 3);
  assert.equal(relocation.linkedCount, 3);

  const finding = checkDoc(dir).reasons.find((r) => r.includes('used to match'));
  assert.match(finding, /3 of 4 now appear at/);
  assert.match(finding, /The other 1 file could not be linked and may have been deleted/);
});

test('relocation: moved and rewritten below git\'s similarity bar says "cannot tell" and names no new folder', (t) => {
  const dir = makeFolderRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src', 'identity'), { recursive: true });
  for (const name of NAMES) {
    git(dir, 'rm', '-q', `src/auth/${name}.js`);
    // Same file names in the new folder, but nothing in common with the old content.
    writeFileSync(join(dir, 'src', 'identity', `${name}.js`), rewrittenSource(name));
  }
  commitAt(dir, 'replace the auth code', '2025-03-01T00:00:00Z');

  // Sanity: git really does see these as delete + add, not renames.
  const status = git(dir, 'log', '-1', '-M', '--name-status', '--pretty=format:');
  assert.doesNotMatch(status, /^R/m);

  const doc = checkDoc(dir);
  assert.equal(doc.freshness, 'orphaned');
  const [relocation] = doc.drift.relocations;
  assert.equal(relocation.suggestedGlob, null);
  assert.equal(relocation.linkedCount, 0);
  assert.equal(relocation.movedCount, 0);

  const finding = doc.reasons.find((r) => r.includes('used to match'));
  assert.match(finding, /kontext cannot tell which/);
  assert.match(finding, /suggests no new `describes`/);
  // The point of the test: same file names in a new folder are tempting, and are a guess.
  assert.doesNotMatch(finding, /identity/);
  assert.doesNotMatch(doc.hint, /identity/);
});

test('relocation: too few files linked to name a new home is also "cannot tell"', (t) => {
  const dir = makeFolderRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // One file moves cleanly; three are rewritten from scratch elsewhere.
  moveFolder(dir, { names: ['session'] });
  for (const name of ['token', 'cookies', 'csrf']) {
    git(dir, 'rm', '-q', `src/auth/${name}.js`);
    writeFileSync(join(dir, 'src', 'identity', `${name}.js`), rewrittenSource(name));
  }
  commitAt(dir, 'move session, rewrite the rest', '2025-03-01T00:00:00Z');

  const [relocation] = checkDoc(dir).drift.relocations;
  assert.equal(relocation.linkedCount, 1);
  assert.equal(relocation.suggestedGlob, null, '1 of 4 is not more than half');
  const finding = checkDoc(dir).reasons.find((r) => r.includes('used to match'));
  assert.match(finding, /links only 1 of them/);
});

test('relocation: files split across two new folders are reported but not collapsed into one glob', (t) => {
  const dir = makeFolderRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  moveFolder(dir, { to: 'identity', names: ['session', 'token'] });
  moveFolder(dir, { to: 'web', names: ['cookies', 'csrf'] });
  commitAt(dir, 'split auth in two', '2025-03-01T00:00:00Z');

  const [relocation] = checkDoc(dir).drift.relocations;
  assert.equal(relocation.linkedCount, 4, 'git links all four');
  assert.equal(relocation.suggestedGlob, null, 'but 2 and 2 is no single new home');
});

test('relocation: no move at all leaves today\'s behaviour untouched', (t) => {
  const dir = makeFolderRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const doc = checkDoc(dir);
  assert.notEqual(doc.freshness, 'orphaned');
  assert.equal(doc.drift.relocations, undefined);
  assert.deepEqual(doc.drift.missingGlobs, []);
  assert.ok(!doc.reasons.some((r) => r.includes('used to match')));
});

test('relocation: a glob that never matched anything does not invent a move', (t) => {
  const dir = makeFolderRepo(['src/payments/**']);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Even with a busy history and a rename elsewhere in the repo.
  moveFolder(dir);
  commitAt(dir, 'move auth to identity', '2025-03-01T00:00:00Z');

  const doc = checkDoc(dir);
  assert.equal(doc.freshness, 'orphaned');
  assert.equal(doc.drift.relocations, undefined);
  assert.equal(findRelocation(dir, 'src/payments/**', listTrackedFiles(dir)), null);
  assert.equal(doc.reasons.length, 1, 'exactly the orphaned line it had before, nothing added');
});

test('relocation: a folder that was simply deleted says it cannot tell, and links nothing', (t) => {
  const dir = makeFolderRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'rm', '-rq', 'src/auth');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'unrelated.js'), rewrittenSource('unrelated'));
  commitAt(dir, 'delete auth', '2025-03-01T00:00:00Z');

  const [relocation] = checkDoc(dir).drift.relocations;
  assert.equal(relocation.fileCount, 4);
  assert.equal(relocation.linkedCount, 0);
  assert.equal(relocation.suggestedGlob, null);
});

test('relocation: a move that is staged but not committed yet is found and says so', (t) => {
  const dir = makeFolderRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  moveFolder(dir);
  git(dir, 'add', '-A'); // no commit

  const [relocation] = checkDoc(dir).drift.relocations;
  assert.equal(relocation.leftIn, null);
  assert.equal(relocation.suggestedGlob, 'src/identity/**');
  const finding = checkDoc(dir).reasons.find((r) => r.includes('used to match'));
  assert.match(finding, /moved in the working tree but not committed yet/);
});

test('relocation: a folder moved twice is followed to where it ended up', (t) => {
  const dir = makeFolderRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  moveFolder(dir);
  commitAt(dir, 'move auth to identity', '2025-03-01T00:00:00Z');
  renameSync(join(dir, 'src', 'identity'), join(dir, 'src', 'iam'));
  git(dir, 'add', '-A');
  commitAt(dir, 'rename identity to iam', '2025-04-01T00:00:00Z');

  const [relocation] = checkDoc(dir).drift.relocations;
  assert.equal(relocation.suggestedGlob, 'src/iam/**');
  assert.equal(relocation.movedCount, 4);
});

test('relocation: a suggested glob that also matches files that were already there says so', (t) => {
  const dir = makeFolderRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src', 'identity'), { recursive: true });
  writeFileSync(join(dir, 'src', 'identity', 'already-here.js'), moduleSource('alreadyHere'));
  writeFileSync(join(dir, 'src', 'identity', 'also-here.js'), moduleSource('alsoHere'));
  commitAt(dir, 'unrelated identity code', '2025-02-15T00:00:00Z');
  moveFolder(dir);
  commitAt(dir, 'move auth to identity', '2025-03-01T00:00:00Z');

  const [relocation] = checkDoc(dir).drift.relocations;
  assert.equal(relocation.suggestedGlob, 'src/identity/**');
  assert.equal(relocation.extraMatches, 2);
  assert.match(
    checkDoc(dir).reasons.find((r) => r.includes('used to match')),
    /also matches 2 files that were not part of the move/,
  );
});

test('relocation: one dead glob among live ones is reported and the verdict is computed as before', (t) => {
  const dir = makeFolderRepo(['src/auth/**', 'docs/auth.md']);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  moveFolder(dir);
  commitAt(dir, 'move auth to identity', '2025-03-01T00:00:00Z');

  const doc = checkDoc(dir);
  assert.notEqual(doc.freshness, 'orphaned', 'docs/auth.md still matches, so the doc is not orphaned');
  assert.deepEqual(doc.drift.missingGlobs, ['src/auth/**']);
  assert.equal(doc.drift.relocations[0].suggestedGlob, 'src/identity/**');
  assert.ok(doc.reasons.some((r) => r.includes('score reduced')), 'the old dead-glob penalty is still applied');
});

test('relocation: a literal file path is followed to its new path', (t) => {
  const dir = makeFolderRepo(['src/auth/session.js']);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  moveFolder(dir);
  commitAt(dir, 'move auth to identity', '2025-03-01T00:00:00Z');

  const [relocation] = checkDoc(dir).drift.relocations;
  assert.equal(relocation.fileCount, 1);
  assert.equal(relocation.suggestedGlob, 'src/identity/session.js');
});

test('relocation: nested layout under the glob is kept (src/auth/**/*.js becomes src/identity/**/*.js)', (t) => {
  const dir = makeFolderRepo(['src/auth/**/*.js']);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  moveFolder(dir);
  commitAt(dir, 'move auth to identity', '2025-03-01T00:00:00Z');

  const [relocation] = checkDoc(dir).drift.relocations;
  assert.equal(relocation.suggestedGlob, 'src/identity/**/*.js');
});

test('experiment: feeding the relocated paths into staleness would leak old paths and is left out', (t) => {
  const dir = makeFolderRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Code changes after the doc, then the folder moves.
  writeFileSync(join(dir, 'src', 'auth', 'token.js'), moduleSource('token', '// after doc'));
  commitAt(dir, 'token change before the move', '2025-02-10T00:00:00Z');
  moveFolder(dir);
  commitAt(dir, 'move auth to identity', '2025-03-01T00:00:00Z');

  const since = '2025-01-01T00:00:01Z';
  const newOnly = commitsTouchingSince(dir, ['src/identity/token.js'], since);
  const both = commitsTouchingSince(dir, ['src/auth/token.js', 'src/identity/token.js'], since);
  // Joining old and new paths does recover the pre-move commit...
  assert.equal(newOnly.count, 1);
  assert.equal(both.count, 2);
  // ...but only by putting a path that no longer exists into `files`, which is
  // documented as a sample of currently tracked files. That, plus the fact that
  // the verdict is already `orphaned` (the worst applicable one) whatever the
  // count says, is why the counts are not touched. See docs/SPEC.md section 9.
  assert.ok(both.files.includes('src/auth/token.js'));

  const doc = checkDoc(dir);
  assert.equal(doc.freshness, 'orphaned');
  assert.equal(doc.drift.commitsSince, 0, 'staleness numbers are exactly what they were before this feature');
  assert.equal(doc.drift.matchedFileCount, 0);
});
