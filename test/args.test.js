import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, getString, getNumber, getBool, getList, editDistance, suggest, formatFlags } from '../dist/util/args.js';

const specs = {
  budget: { type: 'number', alias: 'b', description: 'token budget' },
  format: { type: 'string', alias: 'f', description: 'output format', default: 'text' },
  json: { type: 'boolean', alias: 'j', description: 'json output' },
  strict: { type: 'boolean', alias: 's', description: 'strict mode' },
  tag: { type: 'list', alias: 't', description: 'tags' },
};

test('defaults apply when a flag is absent: false for booleans, empty for lists', () => {
  const r = parseArgs([], specs);
  assert.equal(r.flags.format, 'text');
  assert.equal(r.flags.json, false);
  assert.deepEqual(r.flags.tag, []);
  assert.equal(r.flags.budget, undefined);
});

test('words that are not flags are positionals, in order', () => {
  const r = parseArgs(['fix', 'the', 'login'], specs);
  assert.deepEqual(r.positionals, ['fix', 'the', 'login']);
});

test('a value can follow the flag or sit after an equals sign', () => {
  assert.equal(parseArgs(['--budget', '500'], specs).flags.budget, 500);
  assert.equal(parseArgs(['--budget=750'], specs).flags.budget, 750);
  assert.equal(parseArgs(['--format=json'], specs).flags.format, 'json');
});

test('a number flag given text is an error, not a silent zero', () => {
  const r = parseArgs(['--budget', 'abc'], specs);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /--budget expects a number/);
  assert.equal(r.flags.budget, undefined);
});

test('a negative number is accepted as a value, not mistaken for a flag', () => {
  assert.equal(parseArgs(['--budget', '-5'], specs).flags.budget, -5);
});

test('a flag that needs a value but is last, or followed by another flag, is an error', () => {
  assert.match(parseArgs(['--format'], specs).errors[0], /--format expects a value/);
  const r = parseArgs(['--format', '--json'], specs);
  assert.match(r.errors[0], /--format expects a value/);
  assert.equal(r.flags.json, true);
});

test('booleans: bare, negated with --no-, and explicit true/false', () => {
  assert.equal(parseArgs(['--json'], specs).flags.json, true);
  assert.equal(parseArgs(['--no-json'], specs).flags.json, false);
  assert.equal(parseArgs(['--json=false'], specs).flags.json, false);
  assert.equal(parseArgs(['--json=0'], specs).flags.json, false);
  assert.equal(parseArgs(['--json=true'], specs).flags.json, true);
});

test('list flags collect repeats and comma lists and drop blanks', () => {
  const r = parseArgs(['--tag', 'a,b', '--tag=c', '--tag', ' d , ,e'], specs);
  assert.deepEqual(r.flags.tag, ['a', 'b', 'c', 'd', 'e']);
});

test('short aliases work alone, bundled, and with attached or separate values', () => {
  assert.equal(parseArgs(['-j'], specs).flags.json, true);
  const bundled = parseArgs(['-js'], specs);
  assert.equal(bundled.flags.json, true);
  assert.equal(bundled.flags.strict, true);
  assert.equal(parseArgs(['-b', '300'], specs).flags.budget, 300);
  assert.equal(parseArgs(['-b300'], specs).flags.budget, 300);
  assert.match(parseArgs(['-b'], specs).errors[0], /-b expects a value/);
});

test('unknown flags are collected for the caller, not thrown', () => {
  const r = parseArgs(['--nope', '-z', 'word'], specs);
  assert.deepEqual(r.unknown, ['--nope', '-z']);
  assert.deepEqual(r.positionals, ['word']);
  assert.deepEqual(r.errors, []);
});

test('-- ends flag parsing, so later dashes are plain words', () => {
  const r = parseArgs(['--json', '--', '--budget', '-x'], specs);
  assert.equal(r.flags.json, true);
  assert.deepEqual(r.positionals, ['--budget', '-x']);
  assert.equal(r.flags.budget, undefined);
});

test('a lone dash is a positional (it usually means standard input)', () => {
  assert.deepEqual(parseArgs(['-'], specs).positionals, ['-']);
});

test('--help is always available even when the command declares no flags', () => {
  assert.equal(parseArgs(['--help'], {}).flags.help, true);
  assert.equal(parseArgs(['-h'], {}).flags.help, true);
});

test('the getters read the right type and fall back otherwise', () => {
  const r = parseArgs(['--budget', '9', '--json', '--tag', 'x'], specs);
  assert.equal(getNumber(r, 'budget'), 9);
  assert.equal(getNumber(r, 'format', 42), 42);
  assert.equal(getString(r, 'format'), 'text');
  assert.equal(getString(r, 'budget', 'fallback'), 'fallback');
  assert.equal(getBool(r, 'json'), true);
  assert.equal(getBool(r, 'strict'), false);
  assert.deepEqual(getList(r, 'tag'), ['x']);
  assert.deepEqual(getList(r, 'format'), []);
});

test('editDistance counts single-letter edits', () => {
  assert.equal(editDistance('same', 'same'), 0);
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(editDistance('abc', ''), 3);
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('check', 'chekc'), 2);
});

test('suggest offers the closest command, ignoring case, and nothing when nothing is close', () => {
  const commands = ['check', 'pack', 'map', 'doctor', 'init'];
  assert.equal(suggest('chek', commands), 'check');
  assert.equal(suggest('PACK', commands), 'pack');
  assert.equal(suggest('docter', commands), 'doctor');
  assert.equal(suggest('zzzzzzzz', commands), undefined);
  assert.equal(suggest('anything', []), undefined);
});

test('formatFlags lines up every flag, shows aliases and placeholders, and always lists --help', () => {
  const lines = formatFlags(specs);
  assert.equal(lines.length, Object.keys(specs).length + 1);
  assert.ok(lines.some((l) => l.includes('-b, --budget <number>')));
  assert.ok(lines.some((l) => l.includes('-t, --tag <list>')));
  assert.ok(lines.some((l) => l.includes('-j, --json ') && !l.includes('<')));
  assert.ok(lines.some((l) => l.includes('-h, --help')));
  const descColumn = new Set(lines.map((l) => l.indexOf('token budget') >= 0 ? l.indexOf('token budget') : null).filter((x) => x !== null));
  const col = [...descColumn][0];
  assert.ok(lines.every((l) => l.startsWith('  ')));
  assert.ok(lines.find((l) => l.includes('json output')).indexOf('json output') === col);
});
