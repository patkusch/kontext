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
