/**
 * kontext — the shared contract.
 *
 * Everything in this repo codes against these types. The thesis of the whole
 * project lives here: a context document is not a file, it is a *claim about
 * code that decays over time*. Once a doc declares what it describes, git can
 * prove whether that claim still holds.
 */

/** Frontmatter schema version. Bump only on breaking changes. */
export const KONTEXT_SPEC_VERSION = 1;

/**
 * What role a document plays. Kind drives ranking: when an agent packs context
 * for a task, decisions and runbooks outrank general guides.
 */
export type DocKind =
  | 'guide' // explains how something works
  | 'decision' // an ADR — why we chose X over Y
  | 'runbook' // operational steps to perform
  | 'reference' // lookup material, API surfaces, schemas
  | 'handoff' // state passed between sessions or agents
  | 'index' // a map of other docs
  | 'spec'; // a contract others implement against

/**
 * The verdict on a document's trustworthiness.
 *
 * - fresh      — code it describes has not moved since the doc was last touched
 * - drifting   — code moved, but only slightly (within the warn threshold)
 * - stale      — code moved materially after the doc was last updated
 * - expired    — passed its declared `expires` date or ttlDays
 * - superseded — another doc declares `supersedes: [this]`
 * - orphaned   — describes globs that match no files (doc outlived its subject)
 * - unverified — no `describes` claim, so staleness cannot be proven either way
 */
export type Freshness =
  | 'fresh'
  | 'drifting'
  | 'stale'
  | 'expired'
  | 'superseded'
  | 'orphaned'
  | 'unverified';

/** Ordered worst-to-best; used to pick the dominant verdict when several apply. */
export const FRESHNESS_SEVERITY: Record<Freshness, number> = {
  superseded: 6,
  orphaned: 5,
  expired: 4,
  stale: 3,
  drifting: 2,
  unverified: 1,
  fresh: 0,
};

/** The YAML frontmatter block a kontext-aware document carries. */
export interface KontextFrontmatter {
  /** Spec version this doc was written against. */
  kontext: number;
  /** Stable identifier, unique within the repo. Referenced by supersedes/packs. */
  id: string;
  kind?: DocKind;
  /**
   * Globs of source files this doc makes claims about. This is the load-bearing
   * field — without it, staleness is a vibe rather than a fact.
   */
  describes?: string[];
  /** Shell command that proves the doc is still true (e.g. a test). Optional. */
  verify?: string;
  owner?: string;
  /** ISO date after which the doc is considered expired. */
  expires?: string;
  /** Days since last edit after which the doc expires. Alternative to `expires`. */
  ttlDays?: number;
  /** ids of docs this one replaces. Those docs are marked superseded. */
  supersedes?: string[];
  tags?: string[];
  /** Always include this doc in packs regardless of relevance score. */
  pin?: boolean;
}

/** A parsed markdown document plus everything cheap we can learn from its text. */
export interface DocRecord {
  /** Repo-relative POSIX path. */
  path: string;
  frontmatter: Partial<KontextFrontmatter>;
  hasFrontmatter: boolean;
  /** First H1, or a title-cased filename fallback. */
  title: string;
  headings: string[];
  /** Markdown body with frontmatter stripped. */
  body: string;
  wordCount: number;
  /** Rough token count. Good enough for budgeting, not for billing. */
  tokenEstimate: number;
  /** Hash of body content, used for duplicate detection. */
  contentHash: string;
}

export interface GitCommitInfo {
  sha: string;
  /** ISO 8601. */
  date: string;
  subject: string;
  author: string;
}

/**
 * The proof behind a staleness verdict. Every claim kontext makes must be
 * traceable to a commit — no scores without evidence.
 */
export interface DriftEvidence {
  /** Last commit that touched the doc itself. */
  docLastCommit: GitCommitInfo | null;
  /** Most recent commit touching any file matched by `describes`. */
  codeLastCommit: GitCommitInfo | null;
  /** Whole days the described code is ahead of the doc. Negative means doc leads. */
  driftDays: number;
  /** Count of commits touching described files since the doc last changed. */
  commitsSince: number;
  /** Sample of files that moved after the doc (capped for readability). */
  changedFiles: string[];
  /** How many files the describes globs currently resolve to. */
  matchedFileCount: number;
  /** Globs matching zero files — the doc's subject may have been deleted or moved. */
  missingGlobs: string[];
}

/** The result of running a doc's `verify` command. */
export interface VerifyResult {
  command: string;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  output: string;
}

/** A full freshness verdict for one document. */
export interface FreshnessReport {
  doc: DocRecord;
  freshness: Freshness;
  /** 0–100. 100 is perfectly trustworthy. Used for pack ranking. */
  score: number;
  /** Human-readable justifications, each tied to concrete evidence. */
  reasons: string[];
  drift?: DriftEvidence;
  verify?: VerifyResult;
  supersededBy?: string[];
}

/** Thresholds and behaviour, from `kontext.config.json` or defaults. */
export interface KontextConfig {
  /** Globs of markdown to manage. */
  include: string[];
  exclude: string[];
  /** Drift days at which a doc becomes `drifting`. */
  warnDriftDays: number;
  /** Drift days at which a doc becomes `stale`. */
  staleDriftDays: number;
  /** Commits touching described code that alone justify `stale`. */
  staleCommitCount: number;
  /** Default token ceiling for `kontext pack`. */
  defaultPackBudget: number;
  /** Verdicts that make `kontext check` exit non-zero (for CI gating). */
  failOn: Freshness[];
}

export const DEFAULT_CONFIG: KontextConfig = {
  include: ['**/*.md', '**/*.mdx'],
  exclude: [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/vendor/**',
    '**/CHANGELOG.md',
  ],
  warnDriftDays: 14,
  staleDriftDays: 45,
  staleCommitCount: 10,
  defaultPackBudget: 8000,
  failOn: ['stale', 'expired', 'orphaned'],
};

/** A ranked, budgeted bundle of context assembled for one task. */
export interface ContextPack {
  task: string;
  budget: number;
  tokensUsed: number;
  entries: PackEntry[];
  /** Docs that matched but did not fit the budget. */
  omitted: { path: string; title: string; reason: string }[];
  /** Stale docs deliberately excluded, surfaced so the omission is never silent. */
  excludedForStaleness: { path: string; freshness: Freshness }[];
  generatedAt: string;
}

export interface PackEntry {
  path: string;
  title: string;
  /** 0–1 lexical relevance to the task string. */
  relevance: number;
  freshness: Freshness;
  /** Final rank = relevance weighted by freshness and kind. */
  rank: number;
  tokens: number;
  /** Body, possibly truncated to fit the budget. */
  content: string;
  truncated: boolean;
}
