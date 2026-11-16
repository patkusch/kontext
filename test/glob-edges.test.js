import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, matchAny, matchGlob } from '../dist/util/glob.js';

// describes: globs are written by people, in other people's docs. The matcher must never throw,
// and must mean what the person most likely meant.

test('character classes: a set, a range, and a negated set (with ! or ^)', () => {
  assert.equal(matchGlob('src/[abc].js', 'src/a.js'), true);
  assert.equal(matchGlob('src/[abc].js', 'src/d.js'), false);
  assert.equal(matchGlob('src/v[0-9].js', 'src/v7.js'), true);
  assert.equal(matchGlob('src/v[0-9].js', 'src/vx.js'), false);
  assert.equal(matchGlob('src/[!a].js', 'src/b.js'), true);
  assert.equal(matchGlob('src/[!a].js', 'src/a.js'), false);
  assert.equal(matchGlob('src/[^a].js', 'src/b.js'), true);
  assert.equal(matchGlob('src/[^a].js', 'src/a.js'), false);
});

test('a class can never match a slash, so it cannot reach across folders', () => {
  assert.equal(matchGlob('src[/]a.js', 'src/a.js'), false);
});

test('a bracket with no closing one, or an empty class, is just a bracket', () => {
  assert.equal(matchGlob('docs/[draft.md', 'docs/[draft.md'), true);
  assert.equal(matchGlob('docs/[draft.md', 'docs/d.md'), false);
  assert.equal(matchGlob('a[]b', 'a[]b'), true);
});

test('a closing bracket straight after the opening one is a literal member of the class', () => {
  assert.equal(matchGlob('x[]a]y', 'x]y'), true);
  assert.equal(matchGlob('x[]a]y', 'xay'), true);
  assert.equal(matchGlob('x[]a]y', 'xby'), false);
});

test('a backslash in a glob is a path separator (Windows habits), not an escape',  () => {
  assert.equal(matchGlob('src\\a.js', 'src/a.js'), true);
});

test('characters that mean something inside a class are made harmless', () => {
  assert.equal(matchGlob('x[a^]y', 'x^y'), true, 'a caret that is not first is an ordinary member');
  assert.equal(matchGlob('x[[]y', 'x[y'), true);
});

test('stars: a run of them inside a name is one star, and a lone ** between slashes spans folders', () => {
  assert.equal(matchGlob('src/a**b.js', 'src/aXXb.js'), true);
  assert.equal(matchGlob('src/a**b.js', 'src/a/b.js'), false, 'only a whole segment of ** crosses folders');
  assert.equal(matchGlob('src/**/x.js', 'src/a/b/c/x.js'), true);
  assert.equal(matchGlob('src/**/x.js', 'src/x.js'), true);
});

test('a trailing slash means everything inside the folder', () => {
  assert.equal(matchGlob('src/', 'src/a/b.js'), true);
  assert.equal(matchGlob('src/', 'other/a.js'), false);
});

test('paths are tidied before matching: backslashes, doubled slashes, ./ and a leading or trailing slash', () => {
  assert.equal(matchGlob('src/a.js', 'src\\a.js'), true);
  assert.equal(matchGlob('src/a.js', './src//a.js'), true);
  assert.equal(matchGlob('src/a.js', '/src/a.js'), true);
  assert.equal(matchGlob('./src/*.js', 'src/a.js'), true, 'the glob is tidied the same way');
  assert.equal(matchGlob('src/a', 'src/a/'), true);
});

test('matching is case sensitive, because git is', () => {
  assert.equal(matchGlob('README.md', 'readme.md'), false);
});

test('alternation can contain slashes, several groups multiply, and an unbalanced brace is literal', () => {
  assert.equal(matchGlob('{src/a,lib/b}/x.js', 'src/a/x.js'), true);
  assert.equal(matchGlob('{src/a,lib/b}/x.js', 'lib/b/x.js'), true);
  assert.equal(matchGlob('{src/a,lib/b}/x.js', 'src/b/x.js'), false);
  assert.equal(matchGlob('{a,b}/{c,d}.js', 'b/c.js'), true);
  assert.equal(matchGlob('{a,b}/{c,d}.js', 'b/e.js'), false);
  assert.equal(matchGlob('docs/{draft.md', 'docs/{draft.md'), true);
});

test('too many alternations in one glob does not hang or throw; it just cannot be matched safely', () => {
  const huge = '{a,b}'.repeat(12) + '.js';
  assert.doesNotThrow(() => matchGlob(huge, 'abababababab.js'));
});

test('bad input matches nothing: empty globs, non-strings, empty lists', () => {
  assert.equal(matchGlob('', 'a.js'), false);
  assert.equal(matchGlob(undefined, 'a.js'), false);
  assert.equal(matchGlob('a.js', undefined), false);
  assert.equal(matchGlob(7, 'a.js'), false);
  assert.equal(matchAny([], 'a.js'), false);
  assert.equal(matchAny(undefined, 'a.js'), false);
  assert.equal(matchAny(['', 5, null, '*.js'], 'a.js'), true, 'junk entries are skipped, the real one still counts');
});

test('globToRegExp gives back the same compiled pattern each time and always a regular expression', () => {
  const a = globToRegExp('src/**/*.ts');
  assert.ok(a instanceof RegExp);
  assert.equal(globToRegExp('src/**/*.ts'), a, 'compiled patterns are reused');
  assert.ok(globToRegExp('weird{[}') instanceof RegExp);
});

test('the cache can fill without breaking anything', () => {
  for (let i = 0; i < 2100; i += 1) globToRegExp(`generated/${i}/*.js`);
  assert.equal(matchGlob('generated/5/a.js', 'generated/5/a.js'), true);
  assert.equal(matchGlob('generated/5/a.js', 'generated/6/a.js'), false);
});
