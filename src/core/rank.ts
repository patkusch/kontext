/**
 * rank.ts — packing context for a task.
 *
 * Given a task ("fix the session refresh bug") and a set of freshness verdicts,
 * decide which documents an agent should actually be handed, in what order, and
 * within what token budget.
 *
 * The ranking has two halves, and the second is the point of the whole project:
 *
 *   relevance  — does this doc talk about the task? Pure lexical, no embeddings,
 *                no network, deterministic and explainable.
 *   trust      — is this doc still true? A confidently-wrong stale doc is worse
 *                than no doc at all, so freshness multiplies relevance rather
 *                than merely tie-breaking it.
 *
 * And one rule: the pack never hides what it dropped. Anything excluded for
 * staleness or budget is reported back with a reason.
 */

import {
  type ContextPack,
  type DocKind,
  type DocRecord,
  type Freshness,
  type FreshnessReport,
  type PackEntry,
} from '../types.js';

import { estimateTokens, truncateToTokens } from '../util/tokens.js';

/* -------------------------------------------------------------------------- */
/* Lexical relevance                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Stopwords, plus a handful of words that are ubiquitous in engineering task
 * descriptions ("fix", "add", "update", "code") and therefore carry no signal
 * about *which* doc is relevant.
 */
const STOPWORDS = new Set([
  'a', 'about', 'after', 'again', 'all', 'also', 'am', 'an', 'and', 'any', 'are',
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'between', 'both',
  'but', 'by', 'can', 'cannot', 'could', 'did', 'do', 'does', 'doing', 'done',
  'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has',
  'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if',
  'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'my',
  'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other',
  'our', 'ours', 'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some',
  'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until',
  'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while',
  'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your', 'yours',
  // Task-description filler.
  'add', 'change', 'code', 'file', 'files', 'fix', 'get', 'help', 'implement',
  'make', 'need', 'new', 'please', 'thing', 'update', 'use', 'want', 'work',
]);

/**
 * Deliberately crude stemming: strip plurals, then `-ing`/`-ed`, then a silent
 * trailing `e`, then a doubled consonant. Applied identically to query and doc
 * so the forms meet in the middle — "caching" and "cache" both land on "cach",
 * "running" and "run" both on "run". A real Porter stemmer would be better and
 * would also be a dependency; this covers the cases that actually matter for
 * matching an English task string against English headings.
 */
function stem(word: string): string {
  let w = word;
  if (w.length <= 3) return w;

  // Plurals.
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (/(ches|shes|xes|zes|ses)$/.test(w) && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);

  // Verb forms.
  if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2);

  // Silent trailing e, so cache/caching and base/based converge.
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);

  // Doubled consonant left behind by -ing/-ed removal (runn -> run).
  if (w.length > 3) {
    const last = w[w.length - 1];
    const prev = w[w.length - 2];
    if (last !== undefined && prev !== undefined && last === prev && !'aeiou'.includes(last)) {
      w = w.slice(0, -1);
    }
  }
  return w;
}

/** Split on anything that is not a letter or digit; identifiers keep their parts. */
function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    out.push(stem(raw));
  }
  return out;
}

/** Query terms: tokenized, stopworded, deduplicated, order preserved. */
function queryTerms(task: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of task.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    const s = stem(raw);
    if (s.length < 2 || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** Adjacent pairs of the *unstemmed-order* query terms, for phrase matching. */
function bigrams(terms: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < terms.length; i++) {
    const a = terms[i];
    const b = terms[i + 1];
    if (a !== undefined && b !== undefined) out.push(`${a} ${b}`);
  }
  return out;
}

/**
 * Field weights. The ordering is the spec's: a hit in the title or the doc's id
 * is a statement about what the doc *is*; a hit in the body might be a passing
 * mention. Path sits low but non-zero because `docs/auth/sessions.md` is real
 * evidence that the file is about auth.
 */
const FIELD_WEIGHTS = {
  title: 3.0,
  id: 3.0,
  headings: 2.0,
  tags: 1.5,
  path: 1.2,
  body: 1.0,
} as const;

const K1 = 1.2; // BM25 term-frequency saturation
const B = 0.5; // BM25 length normalization strength (body only)
const REF_BODY_TOKENS = 400; // stand-in for corpus average length

/**
 * How much a single query term is allowed to be worth before diminishing
 * returns kick in. Tuned so one title hit lands around 0.70 and a body-only
 * mention saturates near 0.55 no matter how often it repeats — which is the
 * "don't let a doc that says 'auth' fifty times beat the doc titled 'Auth'"
 * property the spec asks for.
 */
const TERM_SOFTNESS = 2.5;

interface DocIndex {
  fields: { name: keyof typeof FIELD_WEIGHTS; tf: Map<string, number>; length: number }[];
  bigrams: Set<string>;
}

const docIndexCache = new WeakMap<DocRecord, DocIndex>();

function countTokens(tokens: readonly string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

function collectBigrams(tokens: readonly string[], into: Set<string>): void {
  for (let i = 0; i + 1 < tokens.length; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (a !== undefined && b !== undefined) into.add(`${a} ${b}`);
  }
}

function indexDoc(doc: DocRecord): DocIndex {
  const cached = docIndexCache.get(doc);
  if (cached) return cached;

  const titleTokens = tokenize(doc.title);
  const idTokens = tokenize(doc.frontmatter.id ?? '');
  const headingTokens = tokenize((doc.headings ?? []).join(' \n '));
  const tagTokens = tokenize((doc.frontmatter.tags ?? []).join(' '));
  const pathTokens = tokenize(doc.path.replace(/\.mdx?$/i, ''));
  const bodyTokens = tokenize(doc.body);

  const bg = new Set<string>();
  collectBigrams(titleTokens, bg);
  collectBigrams(headingTokens, bg);
  collectBigrams(tagTokens, bg);
  collectBigrams(bodyTokens, bg);

  const index: DocIndex = {
    fields: [
      { name: 'title', tf: countTokens(titleTokens), length: titleTokens.length },
      { name: 'id', tf: countTokens(idTokens), length: idTokens.length },
      { name: 'headings', tf: countTokens(headingTokens), length: headingTokens.length },
      { name: 'tags', tf: countTokens(tagTokens), length: tagTokens.length },
      { name: 'path', tf: countTokens(pathTokens), length: pathTokens.length },
      { name: 'body', tf: countTokens(bodyTokens), length: bodyTokens.length },
    ],
    bigrams: bg,
  };
  docIndexCache.set(doc, index);
  return index;
}

/** BM25 term saturation. Only the body gets length normalization. */
function saturate(tf: number, length: number, normalize: boolean): number {
  if (tf <= 0) return 0;
  const denom = normalize ? tf + K1 * (1 - B + (B * length) / REF_BODY_TOKENS) : tf + K1;
  return (tf * (K1 + 1)) / denom;
}

/**
 * Lexical relevance of a doc to a task, in 0..1.
 *
 * Per query term we sum weighted, saturated hits across fields, then squash
 * with `1 - e^(-x/k)` so a term can be "found" but never dominate. The doc
 * score is the mean over query terms, which makes *coverage* matter: a doc
 * matching three of three query terms weakly beats one matching one term
 * loudly. A phrase bonus then closes part of the remaining gap when the query's
 * adjacent word pairs appear intact in the doc.
 *
 * No IDF: the signature takes a single doc, so there is no corpus to compute
 * document frequencies against. The stopword list is doing the job IDF would.
 */
export function scoreRelevance(task: string, doc: DocRecord): number {
  const terms = queryTerms(task);
  if (terms.length === 0) return 0;

  const index = indexDoc(doc);
  let sum = 0;

  for (const term of terms) {
    let contribution = 0;
    for (const field of index.fields) {
      const tf = field.tf.get(term);
      if (tf === undefined) continue;
      contribution +=
        FIELD_WEIGHTS[field.name] * saturate(tf, field.length, field.name === 'body');
    }
    if (contribution > 0) sum += 1 - Math.exp(-contribution / TERM_SOFTNESS);
  }

  let score = sum / terms.length;

  // Phrase bonus: closes up to 30% of the remaining headroom, proportional to
  // how many of the query's adjacent pairs survive intact in the doc.
  const qb = bigrams(terms);
  if (qb.length > 0) {
    let hits = 0;
    for (const pair of qb) if (index.bigrams.has(pair)) hits++;
    if (hits > 0) score += (1 - score) * 0.3 * (hits / qb.length);
  }

  // Explicit id callout: if the task names the doc's id verbatim, the author is
  // pointing at this document. Nothing lexical should outrank that.
  const id = doc.frontmatter.id;
  if (typeof id === 'string' && id.length >= 3 && task.toLowerCase().includes(id.toLowerCase())) {
    score = Math.max(score, 0.9);
  }

  return Math.min(1, Math.max(0, Math.round(score * 10_000) / 10_000));
}

/* -------------------------------------------------------------------------- */
/* Pack building                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Trust multipliers. These are steep on purpose: handing an agent a stale doc
 * is the failure mode kontext exists to prevent, so `stale` costs a doc 75% of
 * its relevance rather than nudging it down a slot.
 *
 * `unverified` sits high — a doc with no `describes` has not been shown to be
 * wrong, it has only failed to make itself checkable, and punishing it as
 * harshly as proven drift would make the tool useless on day one of adoption.
 */
const FRESHNESS_WEIGHT: Record<Freshness, number> = {
  fresh: 1.0,
  unverified: 0.75,
  drifting: 0.6,
  stale: 0.25,
  expired: 0.15,
  orphaned: 0.1,
  superseded: 0.05,
};

/**
 * Kind multipliers. Decisions and runbooks say *why* and *how to act*, which is
 * exactly what an agent cannot reconstruct from source; guides and indexes
 * largely restate what reading the code would reveal.
 */
const KIND_WEIGHT: Record<DocKind, number> = {
  decision: 1.15,
  runbook: 1.15,
  spec: 1.1,
  handoff: 1.05,
  reference: 1.0,
  guide: 0.95,
  index: 0.8,
};
const UNKNOWN_KIND_WEIGHT = 0.9;

/** Verdicts excluded from packs unless `includeStale` is set. */
const DEGRADED: ReadonlySet<Freshness> = new Set<Freshness>([
  'stale',
  'expired',
  'orphaned',
  'superseded',
]);

/**
 * Below this relevance a doc is not a near-miss, it is simply about something
 * else. Such docs are dropped without an `omitted` entry — listing every
 * unrelated doc in the repo would bury the omissions that actually matter.
 */
const RELEVANCE_FLOOR = 0.05;

/** Relevance used when the task string carries no usable terms at all. */
const NEUTRAL_RELEVANCE = 0.5;

interface Candidate {
  report: FreshnessReport;
  relevance: number;
  rank: number;
  pinned: boolean;
}

function kindWeight(doc: DocRecord): number {
  const kind = doc.frontmatter.kind;
  return kind !== undefined && kind in KIND_WEIGHT ? KIND_WEIGHT[kind] : UNKNOWN_KIND_WEIGHT;
}

/**
 * Final rank.
 *
 *   rank = relevance x kindWeight x freshnessWeight x (0.6 + 0.4 * score/100)
 *
 * The last factor lets the continuous freshness score break ties *within* a
 * verdict — of two drifting docs, the one 15 days behind outranks the one 44
 * days behind — without letting it cross verdict boundaries on its own.
 */
function computeRank(relevance: number, report: FreshnessReport): number {
  const trust =
    FRESHNESS_WEIGHT[report.freshness] * (0.6 + 0.4 * (Math.max(0, Math.min(100, report.score)) / 100));
  return relevance * kindWeight(report.doc) * trust;
}

/**
 * Build a token-budgeted context pack for a task.
 *
 * Order of operations, and why:
 *  1. kind filter — an explicit user filter, applied silently.
 *  2. relevance — computed for everything that survives the filter.
 *  3. relevance floor — irrelevant docs vanish without noise.
 *  4. staleness gate — applied *after* the floor, so `excludedForStaleness`
 *     lists the stale docs the user would have wanted, not every stale doc in
 *     the repo.
 *  5. greedy fill in rank order, truncating the doc that straddles the budget
 *     rather than dropping it whole.
 */
export function buildPack(
  task: string,
  reports: FreshnessReport[],
  opts: { budget: number; includeStale?: boolean; kinds?: DocKind[] },
): ContextPack {
  const budget = Math.max(0, Math.floor(opts.budget));
  const includeStale = opts.includeStale === true;
  const kindFilter = opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : null;

  const hasQuery = queryTerms(task).length > 0;

  const entries: PackEntry[] = [];
  const omitted: ContextPack['omitted'] = [];
  const excludedForStaleness: ContextPack['excludedForStaleness'] = [];

  const candidates: Candidate[] = [];

  for (const report of reports) {
    const doc = report.doc;

    // 1. kind filter
    if (kindFilter) {
      const kind = doc.frontmatter.kind;
      if (kind === undefined || !kindFilter.has(kind)) continue;
    }

    // 2. relevance
    const relevance = hasQuery ? scoreRelevance(task, doc) : NEUTRAL_RELEVANCE;
    const pinned = doc.frontmatter.pin === true;

    // 3. relevance floor (pinned docs bypass it — pinning is explicit intent)
    if (!pinned && hasQuery && relevance < RELEVANCE_FLOOR) continue;

    // 4. staleness gate
    if (!pinned && !includeStale && DEGRADED.has(report.freshness)) {
      excludedForStaleness.push({ path: doc.path, freshness: report.freshness });
      continue;
    }

    candidates.push({ report, relevance, rank: computeRank(relevance, report), pinned });
  }

  // Pinned docs lead, then rank descending. Ties broken by freshness score and
  // then path so packs are byte-stable across runs.
  candidates.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (b.rank !== a.rank) return b.rank - a.rank;
    if (b.report.score !== a.report.score) return b.report.score - a.report.score;
    return a.report.doc.path.localeCompare(b.report.doc.path);
  });

  // 5. greedy fill.
  // A truncated tail entry is only worth including if enough budget survives to
  // carry real content; below that it is a stub that costs tokens and teaches
  // the agent nothing, so it goes to `omitted` instead.
  const minUsefulTail = Math.max(120, Math.floor(budget * 0.05));
  let used = 0;
  let full = false;

  for (const candidate of candidates) {
    const doc = candidate.report.doc;
    const remaining = budget - used;

    if (full) {
      omitted.push({
        path: doc.path,
        title: doc.title,
        reason: `budget exhausted (${budget} tokens); this doc ranked ${candidate.rank.toFixed(3)} with relevance ${candidate.relevance.toFixed(2)}`,
      });
      continue;
    }

    const cost = estimateTokens(doc.body);

    if (cost <= remaining) {
      entries.push({
        path: doc.path,
        title: doc.title,
        relevance: candidate.relevance,
        freshness: candidate.report.freshness,
        rank: Math.round(candidate.rank * 10_000) / 10_000,
        tokens: cost,
        content: doc.body,
        truncated: false,
      });
      used += cost;
      continue;
    }

    if (remaining >= minUsefulTail) {
      // `truncateToTokens` cuts on block boundaries (it keeps code fences and
      // headings intact), so the text it returns can re-estimate slightly ABOVE
      // the target it was given. The budget is a hard contract, not a target: an
      // agent that asked for 8k tokens must never be handed 8.1k, because the
      // overflow is silently dropped at the far end where nobody can see it.
      // So shrink until it genuinely fits, backing off 10% per attempt.
      let target = remaining;
      let cut = truncateToTokens(doc.body, target);
      let actual = estimateTokens(cut.text);
      for (let attempt = 0; attempt < 8 && actual > remaining; attempt++) {
        target = Math.floor(target * 0.9);
        if (target < 1) break;
        cut = truncateToTokens(doc.body, target);
        actual = estimateTokens(cut.text);
      }

      if (actual > remaining) {
        // Could not be made to fit. Report it rather than blowing the budget.
        omitted.push({
          path: doc.path,
          title: doc.title,
          reason: `could not be truncated to fit the remaining ${remaining} tokens of the ${budget}-token budget`,
        });
        full = true;
        continue;
      }

      entries.push({
        path: doc.path,
        title: doc.title,
        relevance: candidate.relevance,
        freshness: candidate.report.freshness,
        rank: Math.round(candidate.rank * 10_000) / 10_000,
        tokens: actual,
        content: cut.text,
        truncated: cut.truncated || actual < cost,
      });
      used += actual;
    } else {
      omitted.push({
        path: doc.path,
        title: doc.title,
        reason: `needs ~${cost} tokens but only ${remaining} of the ${budget}-token budget remained`,
      });
    }
    full = true;
  }

  return {
    task,
    budget,
    tokensUsed: used,
    entries,
    omitted,
    excludedForStaleness,
    generatedAt: new Date().toISOString(),
  };
}
