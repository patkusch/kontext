/**
 * conflicts.ts — finding where documents disagree.
 *
 * Staleness is one way context lies to an agent. The other is contradiction:
 * two docs, both plausible, giving two different answers. The agent picks one
 * at random and half the time it is wrong.
 *
 * The governing principle here is **precision over recall**. A false
 * contradiction is worse than a missed one, because the first time a developer
 * investigates a flagged "conflict" and finds two perfectly compatible
 * sentences, they stop trusting every other finding the tool produces. Every
 * extractor below therefore asserts a fact only when the syntax is unambiguous,
 * and every comparison bails out when the doc itself is ambiguous.
 *
 * What we deliberately do NOT flag, and why:
 *  - Prose disagreements ("we use Redis" vs "we no longer use Redis"). Detecting
 *    these needs entailment, not regex; anything regex-shaped here is a coin flip.
 *  - Two different ports mentioned in the same doc. That is a doc describing an
 *    app and a database, not a doc contradicting itself — so such a doc simply
 *    abstains from the port fact rather than poisoning the comparison.
 *  - Version differences below the major (Node 20.1 vs 20.4, TypeScript 5.2 vs
 *    5.6). Real projects float within a major on purpose.
 *  - Any comparison where either side states a *range* (`>=18`, `^20`, `18+`).
 *    "Node >= 18" and "Node 20" are compatible, not contradictory.
 *  - Placeholder values (`API_KEY=<your-key>`, `URL=${BASE}`, `TOKEN=xxx`).
 *  - Generic numeric config — timeouts, retries, pool sizes, limits. Too many
 *    legitimate contexts share a key name.
 *  - Docs living under `archive/`, `legacy/`, `old/`, `deprecated/`, and
 *    changelogs. Historical documents are *supposed* to record former values.
 *  - Any doc that another doc declares it `supersedes`. Superseding a doc is an
 *    explicit statement that it disagrees on purpose.
 */

import { type DocRecord } from '../types.js';

export interface Conflict {
  kind: 'duplicate' | 'contradiction' | 'duplicate-id';
  severity: 'high' | 'medium' | 'low';
  docs: string[];
  detail: string;
  evidence: string[];
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Paths whose contents are historical by design and must not be compared. */
const HISTORICAL_PATH = /(^|\/)(archive|archived|legacy|old|deprecated|history)(\/|$)|CHANGELOG/i;

function isHistorical(doc: DocRecord): boolean {
  return HISTORICAL_PATH.test(doc.path);
}

/** Trim a source line down to something quotable in a terminal. */
function quoteLine(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

/**
 * Evidence is body-relative: `doc.body` has frontmatter stripped, so the line
 * number is an offset into the body, not into the file. Labelled explicitly so
 * nobody chases a mismatched line number in an editor.
 */
function evidenceFor(doc: DocRecord, line: number, text: string): string {
  return `${doc.path} (body line ${line}): ${quoteLine(text)}`;
}

function severityRank(s: Conflict['severity']): number {
  return s === 'high' ? 0 : s === 'medium' ? 1 : 2;
}

/* -------------------------------------------------------------------------- */
/* 1. Duplicate ids                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `id` is the primary key of the whole system — `supersedes` and pack
 * references resolve through it. Two docs sharing one is unambiguously broken,
 * so this is the only check with no heuristics in it at all.
 */
function findDuplicateIds(docs: DocRecord[]): Conflict[] {
  const byId = new Map<string, DocRecord[]>();
  for (const doc of docs) {
    const id = doc.frontmatter.id;
    if (typeof id !== 'string' || id.trim().length === 0) continue;
    const key = id.trim();
    const list = byId.get(key);
    if (list) list.push(doc);
    else byId.set(key, [doc]);
  }

  const out: Conflict[] = [];
  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    out.push({
      kind: 'duplicate-id',
      severity: 'high',
      docs: group.map((d) => d.path).sort(),
      detail: `${group.length} docs declare the same frontmatter id \`${id}\` — \`supersedes\` and pack references to this id are ambiguous`,
      evidence: group.map((d) => `${d.path}: id: ${id}`),
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 2. Duplicates / near-duplicates                                             */
/* -------------------------------------------------------------------------- */

const SHINGLE_SIZE = 5;
/** Below this, docs are stubs and near-identical boilerplate is meaningless. */
const MIN_WORDS_FOR_SIMILARITY = 40;
/** Jaccard above which two bodies are "the same doc twice". */
const DUPLICATE_THRESHOLD = 0.8;
/** Size of the bottom-k sketch used to prefilter candidate pairs. */
const SKETCH_SIZE = 64;

/** FNV-1a, 32-bit. Deterministic, dependency-free, plenty for shingling. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface SimIndex {
  doc: DocRecord;
  shingles: Set<number>;
  /** The SKETCH_SIZE smallest hashes, ascending — a bottom-k MinHash sketch. */
  sketch: number[];
}

function buildSimIndex(doc: DocRecord): SimIndex | null {
  const words = doc.body
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ') // fenced code is often boilerplate-identical
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
  if (words.length < MIN_WORDS_FOR_SIMILARITY) return null;

  const shingles = new Set<number>();
  for (let i = 0; i + SHINGLE_SIZE <= words.length; i++) {
    shingles.add(hash32(words.slice(i, i + SHINGLE_SIZE).join(' ')));
  }
  if (shingles.size === 0) return null;

  const sketch = [...shingles].sort((a, b) => a - b).slice(0, SKETCH_SIZE);
  return { doc, shingles, sketch };
}

/** Bottom-k Jaccard estimate: cheap enough to run on every pair. */
function sketchSimilarity(a: SimIndex, b: SimIndex): number {
  const k = Math.min(a.sketch.length, b.sketch.length, SKETCH_SIZE);
  if (k === 0) return 0;
  const merged = [...new Set([...a.sketch, ...b.sketch])].sort((x, y) => x - y).slice(0, k);
  let both = 0;
  for (const h of merged) if (a.shingles.has(h) && b.shingles.has(h)) both++;
  return both / k;
}

function exactJaccard(a: Set<number>, b: Set<number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const h of small) if (large.has(h)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function findDuplicates(docs: DocRecord[]): Conflict[] {
  const out: Conflict[] = [];

  // Byte-identical bodies first — no similarity maths required.
  const byHash = new Map<string, DocRecord[]>();
  for (const doc of docs) {
    if (typeof doc.contentHash !== 'string' || doc.contentHash.length === 0) continue;
    const list = byHash.get(doc.contentHash);
    if (list) list.push(doc);
    else byHash.set(doc.contentHash, [doc]);
  }
  // Docs already reported as byte-identical are collapsed to one representative
  // for the near-duplicate pass. Dropping the whole group instead would hide a
  // third doc that is a 90% copy of all of them.
  const identical = new Set<string>();
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    const paths = group.map((d) => d.path).sort();
    for (const p of paths.slice(1)) identical.add(p);
    out.push({
      kind: 'duplicate',
      severity: 'high',
      docs: paths,
      detail: `${group.length} docs have byte-identical bodies (${group[0]?.wordCount ?? 0} words) — an agent reading both learns nothing twice, and only one of them will get updated`,
      evidence: paths.map((p) => `${p}: identical content hash`),
    });
  }

  // Near-duplicates.
  const indexes: SimIndex[] = [];
  for (const doc of docs) {
    if (identical.has(doc.path)) continue; // already reported
    const idx = buildSimIndex(doc);
    if (idx) indexes.push(idx);
  }

  for (let i = 0; i < indexes.length; i++) {
    const a = indexes[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < indexes.length; j++) {
      const b = indexes[j];
      if (b === undefined) continue;

      // Size bound: J >= t implies min(|A|,|B|)/max(|A|,|B|) >= t, because the
      // intersection cannot exceed the smaller set nor the union the larger.
      // A cheap exact filter that removes almost every pair.
      const lo = Math.min(a.shingles.size, b.shingles.size);
      const hi = Math.max(a.shingles.size, b.shingles.size);
      if (lo / hi < DUPLICATE_THRESHOLD) continue;

      // Sketch prefilter before touching the full sets.
      if (sketchSimilarity(a, b) < 0.5) continue;

      const j2 = exactJaccard(a.shingles, b.shingles);
      if (j2 <= DUPLICATE_THRESHOLD) continue;

      const pct = Math.round(j2 * 100);
      out.push({
        kind: 'duplicate',
        severity: j2 > 0.9 ? 'high' : 'medium',
        docs: [a.doc.path, b.doc.path].sort(),
        detail: `${pct}% of 5-word phrases are shared between these two docs — they are near-copies, so updates to one will silently leave the other wrong`,
        evidence: [
          `${a.doc.path}: ${a.doc.wordCount} words, ${a.shingles.size} distinct phrases`,
          `${b.doc.path}: ${b.doc.wordCount} words, ${b.shingles.size} distinct phrases`,
          `Jaccard similarity ${j2.toFixed(2)} (threshold ${DUPLICATE_THRESHOLD})`,
        ],
      });
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* 3. Contradictions                                                           */
/* -------------------------------------------------------------------------- */

interface Fact {
  key: string;
  value: string;
  line: number;
  text: string;
}

/** Severity per fact family — how badly a wrong answer breaks an agent. */
const KEY_SEVERITY: { test: RegExp; severity: Conflict['severity']; label: string }[] = [
  { test: /^script:/, severity: 'high', label: 'run command' },
  { test: /^env:PORT$/, severity: 'high', label: 'environment variable' },
  { test: /^env:/, severity: 'medium', label: 'environment variable' },
  { test: /^version:/, severity: 'medium', label: 'toolchain version' },
  { test: /^url:/, severity: 'medium', label: 'service URL' },
  { test: /^net:/, severity: 'low', label: 'local port' },
];

function keyMeta(key: string): { severity: Conflict['severity']; label: string } {
  for (const entry of KEY_SEVERITY) {
    if (entry.test.test(key)) return { severity: entry.severity, label: entry.label };
  }
  return { severity: 'low', label: 'value' };
}

/**
 * Values that are examples rather than assertions. Comparing these produces
 * pure noise, so a doc containing one abstains from that key entirely.
 */
function isPlaceholder(raw: string): boolean {
  const v = raw.replace(/^["'`]|["'`]$/g, '').trim();
  if (v.length === 0) return true;
  if (/^[<{$]/.test(v)) return true; // <YOUR_KEY>, ${VAR}, {{x}}
  if (v.includes('...') || v.includes('…')) return true;
  if (/^\*+$/.test(v)) return true;
  return /^(your|my|some|example|sample|changeme|change_me|xxx|todo|tbd|placeholder|redacted|dummy|foo|bar)/i.test(
    v,
  );
}

function normalizeValue(raw: string): string {
  const v = raw.replace(/^["'`]|["'`]$/g, '').trim();
  return /^(true|false|null)$/i.test(v) ? v.toLowerCase() : v;
}

/** Origin only — protocol, host, port. Paths and query strings differ legitimately. */
function originOf(url: string): string | null {
  const m = /^(https?:\/\/[^/\s?#]+)/i.exec(url);
  return m && m[1] !== undefined ? m[1].toLowerCase().replace(/\.$/, '') : null;
}

/**
 * A whole-line env assignment: `PORT=8080`, `export API_URL="https://x"`,
 * optionally inside a code fence, a shell prompt, or a list bullet. Anchoring
 * to the entire line is what keeps prose like "set FOO = whatever you like"
 * out of the results.
 */
const ENV_ASSIGN =
  /^[\s>$#*+-]*`{0,3}\s*(?:export\s+|set\s+|ENV\s+)?([A-Z][A-Z0-9_]{2,40})\s*=\s*("[^"]*"|'[^']*'|[^\s`#]+)\s*`{0,3}\s*$/;

/** `npm run dev`, `pnpm dev`, `yarn build`, `bun test`. */
const PKG_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(?:(run)\s+)?([a-z][a-z0-9:_-]{1,30})\b/gi;
/** Bare-invocation script names that are idiomatic without `run`. */
const BARE_SCRIPTS = new Set(['start', 'test', 'dev', 'build', 'install', 'ci', 'lint', 'add']);
/** `npm install <pkg>` / `yarn add <pkg>` are per-package, not a project script. */
const NON_SCRIPT = new Set(['install', 'add', 'ci']);

const LOCALHOST_PORT = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/g;

/** Any range/comparison marker beside a version makes it non-contradictable. */
const VERSION_RANGE = /(>=|<=|>|<|\^|~|\+|or\s+(later|newer|above)|and\s+(up|above))/i;
const NODE_VERSION = /\bnode(?:\.js)?\s*(?:v|version\s+)?\s*([0-9]{1,2})(?:\.[0-9x]+)*/i;
const PYTHON_VERSION = /\bpython\s*(?:v|version\s+)?\s*(3\.[0-9]{1,2})/i;

const LABELLED_URL =
  /\b(base\s*url|api\s*url|service\s*url|BASE_URL|API_URL)\b\s*[:=]?\s*[`"']?(https?:\/\/[^\s`"'<>)]+)/i;

/**
 * Extract every candidate fact from a doc, line by line.
 *
 * Facts are collected with duplicates; `assertedFacts` afterwards discards any
 * key the doc is not self-consistent about. That abstention rule is what makes
 * the whole check safe: a doc listing three ports or two package managers is a
 * doc showing options, and it withdraws from the comparison instead of
 * generating a false conflict against every other doc in the repo.
 */
function extractFacts(doc: DocRecord): Fact[] {
  const facts: Fact[] = [];
  const lines = doc.body.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const lineNo = i + 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    // --- environment variable assignments --------------------------------
    const env = ENV_ASSIGN.exec(line);
    const envName = env?.[1];
    const envValue = env?.[2];
    if (envName !== undefined && envValue !== undefined && !isPlaceholder(envValue)) {
      const value = normalizeValue(envValue);
      // URLs compare by origin so trailing paths do not create phantom conflicts.
      const origin = originOf(value);
      facts.push({
        key: `env:${envName}`,
        value: origin ?? value,
        line: lineNo,
        text: trimmed,
      });
    }

    // --- package-manager-per-script --------------------------------------
    PKG_COMMAND.lastIndex = 0;
    let cmd: RegExpExecArray | null;
    while ((cmd = PKG_COMMAND.exec(line)) !== null) {
      const manager = cmd[1]?.toLowerCase();
      const explicitRun = cmd[2] !== undefined;
      const script = cmd[3]?.toLowerCase();
      if (manager === undefined || script === undefined) continue;
      if (!explicitRun && !BARE_SCRIPTS.has(script)) continue;
      if (NON_SCRIPT.has(script)) continue; // installing a package is not a script
      facts.push({ key: `script:${script}`, value: manager, line: lineNo, text: trimmed });
    }

    // --- localhost port ---------------------------------------------------
    LOCALHOST_PORT.lastIndex = 0;
    let port: RegExpExecArray | null;
    while ((port = LOCALHOST_PORT.exec(line)) !== null) {
      const p = port[1];
      if (p !== undefined) {
        facts.push({ key: 'net:localhost-port', value: p, line: lineNo, text: trimmed });
      }
    }

    // --- toolchain versions ----------------------------------------------
    if (!VERSION_RANGE.test(trimmed)) {
      const node = NODE_VERSION.exec(trimmed);
      const nodeMajor = node?.[1];
      // Guard against "Node 18" matching inside a sentence about something else
      // and against bare years/ports being read as versions.
      if (nodeMajor !== undefined && Number(nodeMajor) >= 4 && Number(nodeMajor) <= 40) {
        facts.push({ key: 'version:node', value: nodeMajor, line: lineNo, text: trimmed });
      }
      const py = PYTHON_VERSION.exec(trimmed);
      const pyVersion = py?.[1];
      if (pyVersion !== undefined) {
        facts.push({ key: 'version:python', value: pyVersion, line: lineNo, text: trimmed });
      }
    }

    // --- explicitly labelled base/API URLs --------------------------------
    const url = LABELLED_URL.exec(line);
    const label = url?.[1];
    const target = url?.[2];
    if (label !== undefined && target !== undefined && !isPlaceholder(target)) {
      const origin = originOf(target);
      if (origin) {
        const key = /api/i.test(label) ? 'url:api' : /service/i.test(label) ? 'url:service' : 'url:base';
        facts.push({ key, value: origin, line: lineNo, text: trimmed });
      }
    }
  }

  return facts;
}

/**
 * Reduce a doc's raw facts to the ones it actually *asserts*: exactly one
 * distinct value per key. Anything the doc says two ways, it does not say.
 */
function assertedFacts(doc: DocRecord): Map<string, Fact> {
  const grouped = new Map<string, Fact[]>();
  for (const fact of extractFacts(doc)) {
    const list = grouped.get(fact.key);
    if (list) list.push(fact);
    else grouped.set(fact.key, [fact]);
  }

  const asserted = new Map<string, Fact>();
  for (const [key, list] of grouped) {
    const distinct = new Set(list.map((f) => f.value));
    if (distinct.size !== 1) continue; // the doc is ambiguous; it abstains
    const first = list[0];
    if (first !== undefined) asserted.set(key, first);
  }
  return asserted;
}

function findContradictions(docs: DocRecord[]): Conflict[] {
  // A doc that another doc supersedes is expected to disagree — that is the
  // whole point of superseding it.
  const superseded = new Set<string>();
  for (const doc of docs) {
    const list = doc.frontmatter.supersedes;
    if (!Array.isArray(list)) continue;
    for (const id of list) if (typeof id === 'string') superseded.add(id);
  }

  const eligible = docs.filter((doc) => {
    if (isHistorical(doc)) return false;
    const id = doc.frontmatter.id;
    if (typeof id === 'string' && superseded.has(id)) return false;
    return true;
  });

  const perDoc = eligible.map((doc) => ({ doc, facts: assertedFacts(doc) }));

  // key -> value -> docs asserting it
  const byKey = new Map<string, Map<string, { doc: DocRecord; fact: Fact }[]>>();
  for (const { doc, facts } of perDoc) {
    for (const [key, fact] of facts) {
      let values = byKey.get(key);
      if (!values) {
        values = new Map();
        byKey.set(key, values);
      }
      const list = values.get(fact.value);
      if (list) list.push({ doc, fact });
      else values.set(fact.value, [{ doc, fact }]);
    }
  }

  const out: Conflict[] = [];
  for (const [key, values] of byKey) {
    if (values.size < 2) continue;

    const meta = keyMeta(key);
    const involved: { doc: DocRecord; fact: Fact }[] = [];
    const rendered: string[] = [];
    for (const [value, holders] of values) {
      for (const h of holders) involved.push(h);
      const who = holders.map((h) => h.doc.path).sort();
      rendered.push(`\`${value}\` (${who.join(', ')})`);
    }

    const subject = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
    out.push({
      kind: 'contradiction',
      severity: meta.severity,
      docs: [...new Set(involved.map((h) => h.doc.path))].sort(),
      detail: `docs disagree on ${meta.label} \`${subject}\`: ${rendered.join(' vs ')}`,
      evidence: involved
        .map((h) => evidenceFor(h.doc, h.fact.line, h.fact.text))
        .sort(),
    });
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Find every place the corpus disagrees with itself.
 *
 * Results are ordered worst-first so a truncated terminal listing still shows
 * the findings that matter.
 */
export function findConflicts(docs: DocRecord[]): Conflict[] {
  const conflicts = [
    ...findDuplicateIds(docs),
    ...findContradictions(docs),
    ...findDuplicates(docs),
  ];

  const kindOrder: Record<Conflict['kind'], number> = {
    'duplicate-id': 0,
    contradiction: 1,
    duplicate: 2,
  };

  return conflicts.sort((a, b) => {
    const s = severityRank(a.severity) - severityRank(b.severity);
    if (s !== 0) return s;
    const k = kindOrder[a.kind] - kindOrder[b.kind];
    if (k !== 0) return k;
    return a.docs.join(',').localeCompare(b.docs.join(','));
  });
}
