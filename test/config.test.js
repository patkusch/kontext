import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONFIG_FILENAME, findRepoRoot, isHomeDirRoot, loadConfig } from '../dist/core/config.js';
import { DEFAULT_CONFIG } from '../dist/types.js';

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kontext-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run loadConfig on a folder holding `content` as its config file, and collect the warnings. */
function load(t, content) {
  const dir = tmp(t);
  if (content !== undefined) writeFileSync(join(dir, CONFIG_FILENAME), typeof content === 'string' ? content : JSON.stringify(content));
  const warnings = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    warnings.push(String(chunk));
    return true;
  };
  try {
    return { config: loadConfig(dir), warnings };
  } finally {
    process.stderr.write = original;
  }
}

test('with no config file you get the defaults and no warnings', (t) => {
  const { config, warnings } = load(t);
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.deepEqual(warnings, []);
});

test('loading a config never changes the shared defaults', (t) => {
  const before = JSON.stringify(DEFAULT_CONFIG);
  const { config } = load(t, { include: ['docs/**/*.md'], exclude: ['drafts/**'], failOn: [] });
  config.include.push('x');
  config.exclude.push('y');
  assert.equal(JSON.stringify(DEFAULT_CONFIG), before);
});

test('include replaces the default list, because a union would scan the whole repo anyway', (t) => {
  const { config } = load(t, { include: ['docs/**/*.md'] });
  assert.deepEqual(config.include, ['docs/**/*.md']);
});

test('exclude is added to the defaults, never replacing them, with no duplicates', (t) => {
  const { config } = load(t, { exclude: ['drafts/**', '**/node_modules/**'] });
  assert.ok(config.exclude.includes('**/node_modules/**'));
  assert.ok(config.exclude.includes('**/.git/**'));
  assert.ok(config.exclude.includes('drafts/**'));
  assert.equal(config.exclude.filter((e) => e === '**/node_modules/**').length, 1);
});

test('an empty include list is ignored with a warning, since it would match nothing', (t) => {
  const { config, warnings } = load(t, { include: [] });
  assert.deepEqual(config.include, DEFAULT_CONFIG.include);
  assert.match(warnings.join(''), /include: empty list would match no docs/);
});

test('numbers are read as given, and bad ones fall back to the default with a warning', (t) => {
  const good = load(t, { warnDriftDays: 3, staleDriftDays: 20, staleCommitCount: 7, defaultPackBudget: 1234 }).config;
  assert.equal(good.warnDriftDays, 3);
  assert.equal(good.staleDriftDays, 20);
  assert.equal(good.staleCommitCount, 7);
  assert.equal(good.defaultPackBudget, 1234);

  const bad = load(t, { warnDriftDays: 'soon', staleDriftDays: -4, defaultPackBudget: null });
  assert.equal(bad.config.warnDriftDays, DEFAULT_CONFIG.warnDriftDays);
  assert.equal(bad.config.staleDriftDays, DEFAULT_CONFIG.staleDriftDays);
  assert.equal(bad.config.defaultPackBudget, DEFAULT_CONFIG.defaultPackBudget);
  assert.match(bad.warnings.join(''), /warnDriftDays: "soon" is not a positive number/);
  assert.match(bad.warnings.join(''), /staleDriftDays: -4 is not a positive number/);
});

test('a warn threshold above the stale threshold is pulled down so "drifting" stays reachable', (t) => {
  const { config, warnings } = load(t, { warnDriftDays: 50, staleDriftDays: 10 });
  assert.equal(config.warnDriftDays, 10);
  assert.equal(config.staleDriftDays, 10);
  assert.match(warnings.join(''), /warnDriftDays \(50\) is greater than staleDriftDays \(10\)/);
});

test('failOn keeps real verdicts, drops made-up ones with a warning, and may be empty to never fail', (t) => {
  const mixed = load(t, { failOn: ['stale', 'bogus', 'orphaned'] });
  assert.deepEqual(mixed.config.failOn, ['stale', 'orphaned']);
  assert.match(mixed.warnings.join(''), /failOn: 'bogus' is not a freshness verdict/);
  assert.deepEqual(load(t, { failOn: [] }).config.failOn, []);
});

test('a list with junk in it keeps the good entries and warns about the rest', (t) => {
  const { config, warnings } = load(t, { include: ['  docs/**/*.md  ', 7, '', 'notes/*.md'] });
  assert.deepEqual(config.include, ['docs/**/*.md', 'notes/*.md']);
  assert.match(warnings.join(''), /include: ignoring non-string entry 7/);
  const notAList = load(t, { include: 'docs/*.md' });
  assert.deepEqual(notAList.config.include, DEFAULT_CONFIG.include);
  assert.match(notAList.warnings.join(''), /include: expected a list of strings/);
});

test('unknown options are named in a warning so a typo does not pass silently', (t) => {
  const { warnings } = load(t, { warnDriftDay: 3 });
  assert.match(warnings.join(''), /unknown option 'warnDriftDay' ignored/);
});

test('a broken or wrong-shaped config file falls back to the defaults and says why', (t) => {
  const broken = load(t, '{ not json');
  assert.deepEqual(broken.config, DEFAULT_CONFIG);
  assert.match(broken.warnings.join(''), /kontext\.config\.json is not valid JSON/);
  for (const shape of ['[]', '"text"', '42', 'null']) {
    const r = load(t, shape);
    assert.deepEqual(r.config, DEFAULT_CONFIG, shape);
    assert.match(r.warnings.join(''), /must contain a JSON object/);
  }
});

test('findRepoRoot walks up to the folder that holds .git', (t) => {
  const dir = tmp(t);
  mkdirSync(join(dir, '.git'));
  mkdirSync(join(dir, 'a', 'b', 'c'), { recursive: true });
  assert.equal(findRepoRoot(join(dir, 'a', 'b', 'c')), dir);
  assert.equal(findRepoRoot(dir), dir);
});

test('.git as a plain file (a worktree or submodule) counts too', (t) => {
  const dir = tmp(t);
  writeFileSync(join(dir, '.git'), 'gitdir: /somewhere/else\n');
  mkdirSync(join(dir, 'sub'));
  assert.equal(findRepoRoot(join(dir, 'sub')), dir);
});

test('with no .git anywhere above, the folder you started in is the root', (t) => {
  const dir = tmp(t);
  const start = join(dir, 'plain');
  mkdirSync(start);
  const found = findRepoRoot(start);
  // A stray .git above the temp folder would be a different, but valid, answer; accept only those two.
  assert.ok(found === start || start.startsWith(found), found);
});

test('isHomeDirRoot is true only for the home folder itself', () => {
  assert.equal(isHomeDirRoot(homedir()), true);
  assert.equal(isHomeDirRoot(join(homedir(), 'some', 'project')), false);
  assert.equal(isHomeDirRoot(tmpdir()), false);
});
