/**
 * A dependency-free glob matcher.
 *
 * kontext must run through `npx` with zero install friction, so we cannot pull
 * in minimatch/picomatch. This is a deliberately small subset that covers what
 * `describes:` globs and config include/exclude patterns actually use:
 *
 *   *      one path segment, does not cross `/`
 *   **     zero or more path segments, crosses `/`
 *   ?      exactly one non-`/` character
 *   {a,b}  alternation (expanded before compilation, so `{a/x,b}` works)
 *   [abc]  character class, `[!abc]` / `[^abc]` negated, ranges allowed
 *
 * Paths are POSIX, repo-relative, and carry no leading `./`. Matching is
 * case-sensitive: git is case-sensitive about content even when the filesystem
 * is not, and a doc's claim is about what git tracks.
 */

/** Compiled patterns are reused across thousands of path tests per scan. */
const REGEX_CACHE = new Map<string, RegExp>();
const CACHE_LIMIT = 2000;

/** Guard against `{a,b}{c,d}{e,f}...` blowing up into a huge alternation. */
const MAX_BRACE_EXPANSIONS = 64;

/** Matches everything a path can never contain, i.e. never matches. */
const NEVER = /(?!)/;

/**
 * Compile a glob into an anchored RegExp.
 *
 * Never throws: an un-compilable pattern yields a regex that matches nothing,
 * because kontext reads globs out of other people's frontmatter and a typo in
 * one doc must not take down a whole scan.
 */
export function globToRegExp(glob: string): RegExp {
  const cached = REGEX_CACHE.get(glob);
  if (cached) return cached;

  let re: RegExp;
  try {
    const alternatives = expandBraces(normalizeGlob(glob)).map(compilePattern);
    const source =
      alternatives.length === 1
        ? alternatives[0]!
        : `(?:${alternatives.join('|')})`;
    re = new RegExp(`^${source}$`);
  } catch {
    re = NEVER;
  }

  // Cheap unbounded-growth guard; scans are one-shot so a hard reset is fine.
  if (REGEX_CACHE.size >= CACHE_LIMIT) REGEX_CACHE.clear();
  REGEX_CACHE.set(glob, re);
  return re;
}

/** Test one glob against one repo-relative POSIX path. */
export function matchGlob(glob: string, filePath: string): boolean {
  if (typeof glob !== 'string' || typeof filePath !== 'string') return false;
  if (glob.length === 0) return false;
  return globToRegExp(glob).test(normalizePath(filePath));
}

/** True if any glob matches. An empty glob list matches nothing. */
export function matchAny(globs: string[], filePath: string): boolean {
  if (!Array.isArray(globs) || globs.length === 0) return false;
  const normalized = normalizePath(filePath);
  for (const glob of globs) {
    if (typeof glob !== 'string' || glob.length === 0) continue;
    if (globToRegExp(glob).test(normalized)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */

/** Windows separators, `./` prefixes and duplicate slashes are all noise. */
function normalizePath(filePath: string): string {
  let p = filePath.replace(/\\/g, '/');
  p = p.replace(/\/{2,}/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  if (p.startsWith('/')) p = p.slice(1);
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

function normalizeGlob(glob: string): string {
  let g = glob.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (g.startsWith('./')) g = g.slice(2);
  if (g.startsWith('/')) g = g.slice(1);
  // A trailing slash means "this directory", which for file matching means
  // everything inside it: `src/` behaves as `src/**`.
  if (g.endsWith('/')) g = `${g}**`;
  return g;
}

/* ------------------------------------------------------------------ *
 * Brace expansion
 * ------------------------------------------------------------------ */

/**
 * Expand `{a,b}` alternations into separate patterns *before* compiling.
 *
 * Doing this up front rather than as a regex group is what lets a brace
 * contain a `/` (`{src/a,b}/x.ts`) — the segment splitter below would
 * otherwise cut the alternation in half.
 */
function expandBraces(glob: string): string[] {
  const open = findBraceOpen(glob);
  if (open < 0) return [glob];

  const close = findBraceClose(glob, open);
  if (close < 0) return [glob]; // unbalanced `{` — treat literally

  const prefix = glob.slice(0, open);
  const inner = glob.slice(open + 1, close);
  const suffix = glob.slice(close + 1);

  const options = splitTopLevel(inner, ',');
  // `{a}` with no comma is not an alternation in most shells; keep it literal
  // so a doc that names a literal `{}` path still matches.
  if (options.length < 2) return [glob];

  const out: string[] = [];
  for (const option of options) {
    for (const tail of expandBraces(suffix)) {
      out.push(prefix + option + tail);
      if (out.length > MAX_BRACE_EXPANSIONS) return [glob];
    }
  }
  return out;
}

/** First `{` that is not inside a character class. */
function findBraceOpen(glob: string): number {
  let inClass = false;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '{' && !inClass) return i;
  }
  return -1;
}

/** Matching `}` for the `{` at `open`, honouring nesting. */
function findBraceClose(glob: string, open: number): number {
  let depth = 0;
  let inClass = false;
  for (let i = open; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (!inClass && ch === '{') depth++;
    else if (!inClass && ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on `sep` at brace/class depth zero. */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inClass = false;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (!inClass && ch === '{') depth++;
    else if (!inClass && ch === '}') depth--;

    if (ch === sep && depth === 0 && !inClass) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/* ------------------------------------------------------------------ *
 * Compilation
 * ------------------------------------------------------------------ */

/**
 * Compile a brace-free glob by walking path segments.
 *
 * The `**` zero-directory case is the whole reason this is segment-based.
 * `src/**` + `/*.ts` must match `src/a.ts` (globstar matching *no* directories)
 * as well as `src/a/b/c.ts`. If globstar were compiled in place as `.*` the
 * separators around it would be mandatory and `src/a.ts` would miss.
 *
 * So a `**` segment *absorbs the separator next to it*:
 *   - mid-pattern: `/(?:[^/]+/)*` — zero or more whole directory names, and the
 *     following segment is appended with no extra `/`
 *   - trailing:    `(?:/.*)?`     — the directory itself, or anything under it
 *   - leading:     `(?:[^/]+/)*`  — no preceding separator to absorb
 *
 * Worked examples:
 *   `src/**\/*.ts`        -> `src/(?:[^/]+/)*[^/]*\.ts`      matches src/a.ts ✓, src/a/b/c.ts ✓
 *   `**\/*.md`            -> `(?:[^/]+/)*[^/]*\.md`         matches x.md ✓, docs/x.md ✓
 *   `**\/node_modules/**` -> `(?:[^/]+/)*node_modules(?:/.*)?` matches node_modules ✓ (dir pruning) and a/node_modules/b ✓
 *   `*.md`                -> `[^/]*\.md`                    matches x.md ✓, docs/x.md ✗
 */
function compilePattern(glob: string): string {
  const segments = glob.split('/');
  let out = '';
  let needSeparator = false;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const isLast = i === segments.length - 1;

    if (isGlobstar(segment)) {
      if (isLast) {
        // `a/**` -> `a(?:/.*)?`; a bare `**` -> `.*`
        out += needSeparator ? '(?:/.*)?' : '.*';
      } else {
        out += needSeparator ? '/(?:[^/]+/)*' : '(?:[^/]+/)*';
      }
      // The globstar swallowed the separator; the next segment attaches raw.
      needSeparator = false;
      continue;
    }

    if (needSeparator) out += '/';
    out += compileSegment(segment);
    needSeparator = true;
  }

  return out;
}

/** `**`, `***`, ... all mean the same thing when alone in a segment. */
function isGlobstar(segment: string): boolean {
  return segment.length >= 2 && /^\*+$/.test(segment);
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(text: string): string {
  return text.replace(REGEX_META, '\\$&');
}

/** Compile a single path segment; `*` and `?` never cross `/` here. */
function compileSegment(segment: string): string {
  let out = '';
  let i = 0;

  while (i < segment.length) {
    const ch = segment[i]!;

    if (ch === '*') {
      // Collapse `a**b` (a globstar not alone in its segment) down to one `*`.
      while (segment[i] === '*') i++;
      out += '[^/]*';
      continue;
    }

    if (ch === '?') {
      out += '[^/]';
      i++;
      continue;
    }

    if (ch === '[') {
      const compiled = compileCharClass(segment, i);
      if (compiled) {
        out += compiled.source;
        i = compiled.next;
        continue;
      }
      // Unterminated `[` is a literal bracket, not an error.
      out += '\\[';
      i++;
      continue;
    }

    out += escapeRegex(ch);
    i++;
  }

  return out;
}

/**
 * Compile `[abc]` / `[!a-z]` starting at `start`.
 * Returns null when there is no closing `]`, so the caller can fall back to a
 * literal bracket rather than producing an invalid regex.
 */
function compileCharClass(
  segment: string,
  start: number,
): { source: string; next: number } | null {
  let i = start + 1;
  let negated = false;

  if (segment[i] === '!' || segment[i] === '^') {
    negated = true;
    i++;
  }

  // A `]` immediately after the (optional) negation is a literal `]`.
  let body = '';
  if (segment[i] === ']') {
    body += '\\]';
    i++;
  }

  let closed = false;
  while (i < segment.length) {
    const ch = segment[i]!;
    if (ch === ']') {
      closed = true;
      i++;
      break;
    }
    // Keep `-` ranges intact, neutralise everything that could break out of
    // the class or invert it accidentally.
    if (ch === '\\' || ch === '^' || ch === '[') body += `\\${ch}`;
    else if (ch === '/') body += ''; // a class can never match a separator
    else body += ch;
    i++;
  }

  if (!closed || body.length === 0) return null;
  return { source: `[${negated ? '^/' : ''}${body}]`, next: i };
}
