import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchGlob, matchAny } from '../dist/util/glob.js';

// The `**` zero-directory case is the one everybody gets wrong, and it is the
// case that matters most here: `src/**/*.ts` must match a file sitting directly
// in src/, or `describes` globs silently under-match and docs look fresher than
// they are. A false "fresh" is the worst possible bug in this project.
test('** matches zero directories', () => {
  assert.equal(matchGlob('src/**/*.ts', 'src/a.ts'), true);
  assert.equal(matchGlob('src/**/*.ts', 'src/a/b/c.ts'), true);
  assert.equal(matchGlob('src/**', 'src/a.ts'), true);
  assert.equal(matchGlob('src/**', 'src/deep/nested/file.ts'), true);
});

test('* does not cross directory boundaries', () => {
  assert.equal(matchGlob('*.md', 'README.md'), true);
  assert.equal(matchGlob('*.md', 'docs/x.md'), false);
  assert.equal(matchGlob('docs/*.md', 'docs/x.md'), true);
  assert.equal(matchGlob('docs/*.md', 'docs/sub/x.md'), false);
});

test('brace alternation', () => {
  assert.equal(matchGlob('{src,lib}/*.js', 'src/a.js'), true);
  assert.equal(matchGlob('{src,lib}/*.js', 'lib/a.js'), true);
  assert.equal(matchGlob('{src,lib}/*.js', 'test/a.js'), false);
});

test('question mark matches exactly one character', () => {
  assert.equal(matchGlob('a?.ts', 'ab.ts'), true);
  assert.equal(matchGlob('a?.ts', 'abc.ts'), false);
});

test('regex metacharacters in globs are treated literally', () => {
  // A glob like `src/app.config.ts` must not let `.` match any character,
  // otherwise `describes` over-matches and drift gets attributed wrongly.
  assert.equal(matchGlob('src/app.config.ts', 'src/appXconfig.ts'), false);
  assert.equal(matchGlob('src/app.config.ts', 'src/app.config.ts'), true);
  assert.equal(matchGlob('a+b.ts', 'a+b.ts'), true);
});

test('matchAny is an OR across globs', () => {
  assert.equal(matchAny(['src/**', 'docs/**'], 'docs/a.md'), true);
  assert.equal(matchAny(['src/**', 'docs/**'], 'test/a.md'), false);
  assert.equal(matchAny([], 'anything.ts'), false);
});
