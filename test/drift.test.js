import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanDocs } from '../dist/core/scan.js';
import { assessAll } from '../dist/core/freshness.js';
import { DEFAULT_CONFIG } from '../dist/types.js';

/**
 * End-to-end proof of the core thesis.
 *
 * Everything else in kontext is presentation. This test asks the only question
 * that matters: if a document declares what it describes, and that code then
 * moves, does the document actually get marked stale — with evidence?
 *
 * We build a real git repository with real commits at controlled dates, because
 * mocking git here would test our mock rather than the mechanism.
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

/** Commit everything with a fixed author+committer date so drift is deterministic. */
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

function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400_000);
  return d.toISOString();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'kontext-drift-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

async function assess(dir) {
  const docs = await scanDocs(dir, DEFAULT_CONFIG);
  return assessAll(dir, docs, DEFAULT_CONFIG);
}

const find = (reports, needle) => reports.find((r) => r.doc.path.includes(needle));

test('a doc goes stale when the code it describes moves after it', async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });

  writeFileSync(join(dir, 'src', 'auth', 'session.ts'), 'export const v = 1;\n');
  writeFileSync(
    join(dir, 'docs', 'auth.md'),
    `---
kontext: 1
id: auth
kind: guide
describes:
  - src/auth/**
---

# Auth

How sessions work.
`,
  );
  // 120 days ago: doc and code agree.
  commitAt(dir, 'initial: auth code and its doc', daysAgo(120));

  // 5 days ago: the code moves on. The doc does not.
  writeFileSync(join(dir, 'src', 'auth', 'session.ts'), 'export const v = 2; // reworked\n');
  commitAt(dir, 'rework session refresh', daysAgo(5));

  const reports = await assess(dir);
  const auth = find(reports, 'auth.md');
  assert.ok(auth, 'expected a report for docs/auth.md');

  assert.equal(
    auth.freshness,
    'stale',
    `code moved 115 days after the doc; expected stale, got ${auth.freshness}`,
  );

  // A verdict without evidence is a rumour.
  assert.ok(auth.reasons.length > 0, 'a stale verdict must carry reasons');
  assert.ok(auth.drift, 'a stale verdict must carry drift evidence');
  assert.ok(auth.drift.driftDays > 100, `expected >100 drift days, got ${auth.drift.driftDays}`);
  assert.ok(auth.drift.codeLastCommit, 'expected the drifting commit to be identified');
  assert.match(
    auth.reasons.join(' '),
    /commit|src\/auth/i,
    'reasons must cite the commits or files that caused the verdict',
  );
  assert.ok(auth.score < 50, `a badly stale doc should score low, got ${auth.score}`);
});

test('a doc stays fresh when it is updated alongside its code', async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'src', 'auth', 'session.ts'), 'export const v = 1;\n');
  writeFileSync(
    join(dir, 'docs', 'auth.md'),
    '---\nkontext: 1\nid: auth\ndescribes:\n  - src/auth/**\n---\n\n# Auth\n',
  );
  commitAt(dir, 'initial', daysAgo(120));

  // Code and doc move together — the discipline the tool is meant to reward.
  writeFileSync(join(dir, 'src', 'auth', 'session.ts'), 'export const v = 2;\n');
  writeFileSync(
    join(dir, 'docs', 'auth.md'),
    '---\nkontext: 1\nid: auth\ndescribes:\n  - src/auth/**\n---\n\n# Auth\n\nUpdated for v2.\n',
  );
  commitAt(dir, 'rework session refresh + doc', daysAgo(5));

  const auth = find(await assess(dir), 'auth.md');
  assert.equal(auth.freshness, 'fresh', `expected fresh, got ${auth.freshness}`);
  assert.ok(auth.score >= 80, `a fresh doc should score high, got ${auth.score}`);
});

test('a doc describing deleted code is orphaned, not merely stale', async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# Repo\n');
  writeFileSync(
    join(dir, 'docs', 'queue.md'),
    '---\nkontext: 1\nid: queue\ndescribes:\n  - workers/queue/**\n---\n\n# Queue\n',
  );
  commitAt(dir, 'doc for a subsystem that does not exist', daysAgo(30));

  const queue = find(await assess(dir), 'queue.md');
  assert.equal(
    queue.freshness,
    'orphaned',
    `describes matches zero files; expected orphaned, got ${queue.freshness}`,
  );
  assert.ok(queue.drift?.missingGlobs?.includes('workers/queue/**'));
});

test('a doc with no describes is unverified — absence of evidence, reported as such', async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, 'README.md'), '# Repo\n');
  writeFileSync(join(dir, 'philosophy.md'), '# Philosophy\n\nNo claims about code here.\n');
  commitAt(dir, 'add docs', daysAgo(200));

  const phil = find(await assess(dir), 'philosophy.md');
  assert.equal(phil.freshness, 'unverified');
  // Crucially: age alone must NOT make something stale. A 200-day-old doc that
  // never claimed anything about code has not been proven wrong.
  assert.notEqual(phil.freshness, 'stale');
  assert.ok(phil.reasons.length > 0, 'unverified must explain why it cannot be judged');
});

test('supersession is detected across documents', async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'old.md'), '---\nkontext: 1\nid: old-auth\n---\n\n# Old\n');
  writeFileSync(
    join(dir, 'docs', 'new.md'),
    '---\nkontext: 1\nid: new-auth\nsupersedes:\n  - old-auth\n---\n\n# New\n',
  );
  commitAt(dir, 'supersede the old auth doc', daysAgo(10));

  const old = find(await assess(dir), 'old.md');
  assert.equal(old.freshness, 'superseded');
  assert.ok(
    old.supersededBy?.some((s) => s.includes('new.md')),
    `supersededBy should name the replacing doc's path, got: ${JSON.stringify(old.supersededBy)}`,
  );
});

test('scanning a repo with no commits does not crash', async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, 'README.md'), '# Fresh repo, nothing committed\n');

  // An empty repo is a normal case, not an edge case.
  const reports = await assess(dir);
  assert.ok(Array.isArray(reports));
  assert.equal(reports.length, 1);
  assert.ok(typeof reports[0].freshness === 'string');
});
