/**
 * YAML frontmatter: a deliberately small subset, parsed defensively.
 *
 * kontext runs over other people's repos, where frontmatter is written by hand
 * and is frequently wrong. Two rules follow from that:
 *
 *   1. Never throw. A malformed block yields whatever could be understood plus
 *      an empty-ish record — one bad doc must never abort a whole scan.
 *   2. Ignore rather than guess. A line we cannot parse is dropped, not
 *      coerced into a shape that would make kontext report a confident lie.
 *
 * ── Supported ───────────────────────────────────────────────────────────────
 *   key: value                     scalars: string, number, bool, null, ~
 *   key: 'single'  key: "double"   quoted strings ('' and \" escapes)
 *   key: [a, b, c]                 inline (flow) arrays
 *   key:\n  - a\n  - b             block arrays, indented or flush-left
 *   key:\n  sub: value             one level of nested mapping
 *   key: {a: 1, b: 2}              one level of inline mapping
 *   # comment                      full-line and trailing comments
 *
 * ── Deliberately NOT supported ──────────────────────────────────────────────
 *   anchors/aliases (&a *a), tags (!!str), multi-line scalars (| and >),
 *   multi-document streams, arrays of maps, nesting deeper than one level,
 *   flow collections spanning multiple lines, and YAML 1.1 booleans
 *   (`yes`/`no`/`on`/`off` stay strings — the Norway problem is a bug factory
 *   and nothing in KontextFrontmatter needs them).
 */

import { KONTEXT_SPEC_VERSION } from '../types.js';
import type { DocKind, KontextFrontmatter } from '../types.js';

/** Runtime mirror of the `DocKind` union — types.ts is types-only by design. */
const DOC_KINDS: readonly DocKind[] = [
  'guide',
  'decision',
  'runbook',
  'reference',
  'handoff',
  'index',
  'spec',
];

/** Emission order for serialization: identity, then claims, then metadata. */
const FIELD_ORDER: readonly (keyof KontextFrontmatter)[] = [
  'kontext',
  'id',
  'kind',
  'describes',
  'verify',
  'owner',
  'expires',
  'ttlDays',
  'supersedes',
  'tags',
  'pin',
];

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const DELIMITER_RE = /^---\s*$/;
const CLOSING_RE = /^(?:---|\.\.\.)\s*$/;

/**
 * Split a markdown file into its frontmatter data and its body.
 *
 * `hasFrontmatter` is false when the file does not open with `---`, and also
 * when it opens with `---` but never closes: an unterminated block is treated
 * as body text rather than swallowing the entire document.
 */
export function parseFrontmatter(raw: string): {
  data: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
} {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { data: {}, body: '', hasFrontmatter: false };
  }

  // Strip a UTF-8 BOM; editors add it and it would hide the opening `---`.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/);

  const first = lines[0];
  if (first === undefined || !DELIMITER_RE.test(first)) {
    return { data: {}, body: text, hasFrontmatter: false };
  }

  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && CLOSING_RE.test(line)) {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return { data: {}, body: text, hasFrontmatter: false };
  }

  const block = lines.slice(1, close);
  const body = lines.slice(close + 1).join('\n').replace(/^\n+/, '');

  let data: Record<string, unknown>;
  try {
    data = parseYamlSubset(block);
  } catch {
    // Belt and braces: the parser is written not to throw, but a doc with
    // pathological input must still produce a usable record.
    data = {};
  }

  return { data, body, hasFrontmatter: true };
}

/**
 * Render frontmatter + body back into a markdown file.
 *
 * Round-trip safety is a hard requirement: `kontext init`/`kontext touch`
 * rewrite existing docs, so anything this emits must re-parse under
 * `parseFrontmatter` to an equal value. That is why quoting is conservative
 * and why arrays fall back to block form as soon as an item looks risky.
 */
export function serializeFrontmatter(
  data: Partial<KontextFrontmatter>,
  body: string,
): string {
  const lines: string[] = [];
  const source: Record<string, unknown> = { ...(data as Record<string, unknown>) };

  const emit = (key: string, value: unknown): void => {
    if (value === undefined) return;
    if (Array.isArray(value)) {
      lines.push(...serializeArray(key, value));
      return;
    }
    lines.push(`${key}: ${serializeScalar(value)}`);
  };

  for (const key of FIELD_ORDER) {
    if (key in source) {
      emit(key, source[key]);
      delete source[key];
    }
  }
  // Unknown keys are preserved rather than dropped — users extend frontmatter
  // and silently deleting their fields on rewrite would be hostile.
  for (const key of Object.keys(source).sort()) {
    if (!isPlainKey(key)) continue;
    emit(key, source[key]);
  }

  const bodyText = typeof body === 'string' ? body.replace(/^\n+/, '') : '';
  return `---\n${lines.join('\n')}\n---\n\n${bodyText}`;
}

/**
 * Type-check a parsed frontmatter record against `KontextFrontmatter`.
 *
 * `errors` mean "this doc's claim cannot be trusted"; `warnings` mean "this
 * still works but is probably not what you meant". `value` is the subset that
 * survived validation, so callers can use it without re-checking. Messages are
 * written to be pasted into a terminal and acted on directly.
 */
export function validateFrontmatter(data: Record<string, unknown>): {
  ok: boolean;
  errors: string[];
  warnings: string[];
  value: Partial<KontextFrontmatter>;
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const value: Partial<KontextFrontmatter> = {};

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return {
      ok: false,
      errors: ['frontmatter: expected a mapping of keys to values'],
      warnings,
      value,
    };
  }

  const managed = 'kontext' in data;

  // kontext -----------------------------------------------------------------
  if ('kontext' in data) {
    const spec = data['kontext'];
    if (typeof spec === 'number' && Number.isFinite(spec)) {
      value.kontext = spec;
      if (spec > KONTEXT_SPEC_VERSION) {
        warnings.push(
          `kontext: spec version ${spec} is newer than this tool understands (${KONTEXT_SPEC_VERSION}); some fields may be ignored`,
        );
      }
    } else {
      errors.push(
        `kontext: ${describe(data['kontext'])} is not a number (expected ${KONTEXT_SPEC_VERSION})`,
      );
    }
  }

  // id ----------------------------------------------------------------------
  const id = data['id'];
  if (typeof id === 'string' && id.length > 0) {
    if (ID_RE.test(id)) {
      value.id = id;
    } else {
      errors.push(
        `id: '${id}' is not a valid slug (lowercase letters, digits and hyphens, starting with a letter or digit — try '${slugify(id)}')`,
      );
    }
  } else if (id !== undefined) {
    errors.push(`id: ${describe(id)} is not a string`);
  } else if (managed) {
    errors.push("id: missing (every kontext doc needs a stable id, e.g. 'auth-overview')");
  } else {
    warnings.push("id: missing (add one so other docs can reference this one)");
  }

  // kind --------------------------------------------------------------------
  const kind = data['kind'];
  if (kind !== undefined) {
    if (typeof kind === 'string' && (DOC_KINDS as readonly string[]).includes(kind)) {
      value.kind = kind as DocKind;
    } else {
      errors.push(
        `kind: ${describe(kind)} is not a valid kind (expected one of ${DOC_KINDS.join(', ')})`,
      );
    }
  }

  // describes ---------------------------------------------------------------
  const describes = data['describes'];
  if (describes !== undefined) {
    if (typeof describes === 'string') {
      // A single glob written unquoted is a common and harmless mistake.
      value.describes = [describes];
      warnings.push(
        `describes: '${describes}' is a string; wrap it in a list — describes: [${describes}]`,
      );
    } else {
      const globs = stringArray(describes);
      if (globs === null) {
        errors.push(`describes: ${describe(describes)} is not a list of glob strings`);
      } else {
        const usable = globs.filter((g) => g.trim().length > 0);
        if (usable.length !== globs.length) {
          warnings.push('describes: empty entries were ignored');
        }
        value.describes = usable;
        if (usable.length === 0) {
          warnings.push(
            'describes: empty list — staleness cannot be proven without at least one glob',
          );
        }
      }
    }
  }

  // verify / owner ----------------------------------------------------------
  for (const key of ['verify', 'owner'] as const) {
    const raw = data[key];
    if (raw === undefined) continue;
    if (typeof raw === 'string') value[key] = raw;
    else errors.push(`${key}: ${describe(raw)} is not a string`);
  }

  // expires -----------------------------------------------------------------
  const expires = data['expires'];
  if (expires !== undefined) {
    if (typeof expires !== 'string') {
      errors.push(
        `expires: ${describe(expires)} is not a date string (expected YYYY-MM-DD)`,
      );
    } else if (!isValidIsoDate(expires)) {
      errors.push(`expires: '${expires}' is not a valid date (expected YYYY-MM-DD)`);
    } else {
      value.expires = expires;
    }
  }

  // ttlDays -----------------------------------------------------------------
  const ttlDays = data['ttlDays'];
  if (ttlDays !== undefined) {
    if (typeof ttlDays !== 'number' || !Number.isFinite(ttlDays)) {
      errors.push(`ttlDays: ${describe(ttlDays)} is not a number`);
    } else if (ttlDays <= 0 || !Number.isInteger(ttlDays)) {
      errors.push(`ttlDays: ${ttlDays} must be a positive whole number of days`);
    } else {
      value.ttlDays = ttlDays;
    }
  }
  if (value.expires !== undefined && value.ttlDays !== undefined) {
    warnings.push('expires and ttlDays are both set; expires wins');
  }

  // supersedes / tags -------------------------------------------------------
  for (const key of ['supersedes', 'tags'] as const) {
    const raw = data[key];
    if (raw === undefined) continue;
    if (typeof raw === 'string') {
      value[key] = [raw];
      warnings.push(`${key}: '${raw}' is a string; a list was expected`);
      continue;
    }
    const items = stringArray(raw);
    if (items === null) {
      errors.push(`${key}: ${describe(raw)} is not a list of strings`);
      continue;
    }
    value[key] = items.filter((item) => item.trim().length > 0);
  }
  if (value.supersedes) {
    for (const ref of value.supersedes) {
      if (!ID_RE.test(ref)) {
        warnings.push(
          `supersedes: '${ref}' is not a valid id slug and will never match a doc`,
        );
      }
    }
  }

  // pin ---------------------------------------------------------------------
  const pin = data['pin'];
  if (pin !== undefined) {
    if (typeof pin === 'boolean') value.pin = pin;
    else errors.push(`pin: ${describe(pin)} is not true or false`);
  }

  // Unknown keys are not errors — they are almost always intentional (site
  // generators share this block) — but a near-miss on a known key is worth
  // flagging, since a typo'd `describe:` silently disables staleness proof.
  const known = new Set<string>(FIELD_ORDER as readonly string[]);
  for (const key of Object.keys(data)) {
    if (known.has(key)) continue;
    const near = [...known].find((k) => k.toLowerCase() === key.toLowerCase() || isNearMiss(k, key));
    if (near) warnings.push(`${key}: unknown field — did you mean '${near}'?`);
  }

  return { ok: errors.length === 0, errors, warnings, value };
}

/* ------------------------------------------------------------------ *
 * YAML subset parser
 * ------------------------------------------------------------------ */

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:(?:\s+(.*))?$/;

function parseYamlSubset(lines: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    i++;
    if (raw === undefined) continue;

    // Tabs are illegal YAML indentation; normalise rather than reject.
    const line = raw.replace(/\t/g, '  ');
    if (line.trim().length === 0) continue;
    if (line.trimStart().startsWith('#')) continue;
    if (indentOf(line) > 0) continue; // stray indented line with no owner

    const match = KEY_RE.exec(line);
    if (!match) continue; // unparseable — drop it, never guess

    const key = match[1]!;
    const rest = (match[2] ?? '').trim();

    if (rest.length > 0 && !rest.startsWith('#')) {
      out[key] = parseScalar(rest);
      continue;
    }

    // Empty value: the payload is on the following, more-indented lines (or a
    // flush-left block sequence, which YAML also allows).
    const { value, next } = parseBlock(lines, i);
    i = next;
    if (value !== undefined) out[key] = value;
    else out[key] = null;
  }

  return out;
}

/**
 * Consume the block that follows a `key:` with no inline value.
 * Returns the parsed value and the index of the first unconsumed line.
 */
function parseBlock(
  lines: string[],
  start: number,
): { value: unknown; next: number } {
  let i = start;
  const items: unknown[] = [];
  const map: Record<string, unknown> = {};
  let sawItem = false;
  let sawPair = false;

  while (i < lines.length) {
    const raw = lines[i];
    if (raw === undefined) break;
    const line = raw.replace(/\t/g, '  ');

    if (line.trim().length === 0) {
      i++;
      continue;
    }
    if (line.trimStart().startsWith('#')) {
      i++;
      continue;
    }

    const trimmed = line.trim();
    const indent = indentOf(line);

    if (trimmed.startsWith('- ') || trimmed === '-') {
      // Block sequence item. Allowed at indent 0 (flush-left) per YAML.
      if (sawPair) break;
      sawItem = true;
      const itemText = trimmed === '-' ? '' : trimmed.slice(2).trim();
      items.push(itemText.length > 0 ? parseScalar(itemText) : null);
      i++;
      continue;
    }

    if (indent === 0) break; // back at top level — this block is done

    const match = KEY_RE.exec(trimmed);
    if (!match) {
      i++; // unparseable line inside a block: skip it, keep the rest
      continue;
    }
    if (sawItem) break;
    sawPair = true;
    const subKey = match[1]!;
    const subRest = (match[2] ?? '').trim();
    // Only one level of nesting is supported; a deeper block is skipped by the
    // indent check on the next iteration rather than being mis-attached.
    map[subKey] = subRest.length > 0 && !subRest.startsWith('#') ? parseScalar(subRest) : null;
    i++;
  }

  if (sawItem) return { value: items, next: i };
  if (sawPair) return { value: map, next: i };
  return { value: undefined, next: i };
}

function indentOf(line: string): number {
  const match = /^ */.exec(line);
  return match ? match[0].length : 0;
}

/** Parse one scalar or flow collection. Never throws. */
function parseScalar(input: string): unknown {
  const text = stripTrailingComment(input).trim();

  if (text.length === 0) return null;

  const first = text[0];

  if (first === '"' && text.length > 1 && text.endsWith('"')) {
    return unescapeDouble(text.slice(1, -1));
  }
  if (first === "'" && text.length > 1 && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (first === '[' && text.endsWith(']')) {
    return parseFlowSequence(text.slice(1, -1));
  }
  if (first === '{' && text.endsWith('}')) {
    return parseFlowMapping(text.slice(1, -1));
  }

  if (text === '~' || text === 'null' || text === 'Null' || text === 'NULL') return null;
  if (text === 'true' || text === 'True' || text === 'TRUE') return true;
  if (text === 'false' || text === 'False' || text === 'FALSE') return false;

  // Only plain decimals become numbers. Version strings (`1.2.3`) and dates
  // (`2026-01-01`) must stay strings — validateFrontmatter checks the date,
  // and a Date object here would break round-tripping.
  if (/^-?\d+(?:\.\d+)?$/.test(text)) {
    const num = Number(text);
    if (Number.isFinite(num)) return num;
  }

  return text;
}

function parseFlowSequence(inner: string): unknown[] {
  if (inner.trim().length === 0) return [];
  return splitFlow(inner).map((part) => parseScalar(part));
}

function parseFlowMapping(inner: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (inner.trim().length === 0) return out;
  for (const part of splitFlow(inner)) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim().replace(/^['"]|['"]$/g, '');
    if (key.length === 0) continue;
    out[key] = parseScalar(part.slice(idx + 1));
  }
  return out;
}

/** Split a flow collection on commas that are not inside quotes or brackets. */
function splitFlow(inner: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  let depth = 0;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** A `#` only starts a comment when preceded by whitespace and unquoted. */
function stripTrailingComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1] ?? ''))) {
      return text.slice(0, i);
    }
  }
  return text;
}

function unescapeDouble(text: string): string {
  return text.replace(/\\(["\\/nrt])/g, (_all, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      default:
        return ch;
    }
  });
}

/* ------------------------------------------------------------------ *
 * Serialization helpers
 * ------------------------------------------------------------------ */

function serializeArray(key: string, items: unknown[]): string[] {
  if (items.length === 0) return [`${key}: []`];

  const rendered = items.map((item) => serializeScalar(item));
  const inlineLength = key.length + 2 + rendered.join(', ').length + 2;
  // Inline form only when it stays short and no item needed quoting — the
  // parser handles quoted flow items, but block form is easier to hand-edit.
  const inlineSafe = rendered.every((item) => /^[^'"[\]{},#\s]+$/.test(item));
  if (inlineSafe && inlineLength <= 78) {
    return [`${key}: [${rendered.join(', ')}]`];
  }
  return [`${key}:`, ...rendered.map((item) => `  - ${item}`)];
}

function serializeScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (Array.isArray(value)) {
    // Nested arrays are out of scope; flatten to a flow sequence so it at
    // least round-trips as a list of scalars.
    return `[${value.map((item) => serializeScalar(item)).join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${serializeScalar(v)}`);
    return `{${entries.join(', ')}}`;
  }

  const text = String(value);
  return needsQuoting(text) ? `'${text.replace(/'/g, "''")}'` : text;
}

/**
 * Quote anything that would parse back as a different type or confuse the
 * line scanner. Over-quoting is cheap; under-quoting breaks the round trip.
 */
function needsQuoting(text: string): boolean {
  if (text.length === 0) return true;
  if (text !== text.trim()) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(text)) return true;
  if (/:\s/.test(text) || text.endsWith(':')) return true;
  if (/\s#/.test(text)) return true;
  if (/[\n\r]/.test(text)) return true;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return true;
  if (/^(?:true|false|null|~|True|False|Null|TRUE|FALSE|NULL)$/.test(text)) return true;
  return false;
}

function isPlainKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key);
}

/* ------------------------------------------------------------------ *
 * Validation helpers
 * ------------------------------------------------------------------ */

/**
 * A real calendar date, not merely a parseable one: `2026-02-30` and
 * `2026-13-45` must both be rejected, and `new Date()` happily rolls those
 * over into March and beyond.
 */
function isValidIsoDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(text.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Null when the value is not an array of strings. */
function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else if (typeof item === 'number' || typeof item === 'boolean') out.push(String(item));
    else return null;
  }
  return out;
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'doc';
}

/** Human-readable rendering of a bad value for error messages. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return `a list (${value.length} items)`;
  if (typeof value === 'object') return 'a mapping';
  if (typeof value === 'string') return `'${value}'`;
  return String(value);
}

/** One edit apart — catches `describe`/`describes`, `tag`/`tags`, `pinn`/`pin`. */
function isNearMiss(known: string, actual: string): boolean {
  const a = known.toLowerCase();
  const b = actual.toLowerCase();
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length === longer.length) {
    let diffs = 0;
    for (let i = 0; i < shorter.length; i++) {
      if (shorter[i] !== longer[i]) diffs++;
      if (diffs > 1) return false;
    }
    return diffs === 1;
  }
  for (let i = 0; i <= shorter.length; i++) {
    if (shorter.slice(0, i) === longer.slice(0, i) && shorter.slice(i) === longer.slice(i + 1)) {
      return true;
    }
  }
  return false;
}
