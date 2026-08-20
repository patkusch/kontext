/**
 * freshness.ts — the core of kontext.
 *
 * A context document is a *claim about code*. `describes: [src/auth/**]` is the
 * claim; git is the witness. This module turns that pairing into a verdict with
 * receipts: not "this doc feels old" but "12 commits touched the files this doc
 * describes since the doc itself was last edited, the most recent being a3f9c21
 * 31 days ago".
 *
 * Two rules govern everything here:
 *   1. No verdict without evidence. Every `reasons` entry cites a commit, a
 *      date, a glob, or a file count. A bare "stale" is a bug.
 *   2. When several conditions apply, the worst one names the verdict
 *      (FRESHNESS_SEVERITY) but *all* of them get to lower the score.
 */

import { spawnSync } from 'node:child_process';

import {
  FRESHNESS_SEVERITY,
  type DocRecord,
  type DriftEvidence,
  type Freshness,
  type FreshnessReport,
  type GitCommitInfo,
  type KontextConfig,
  type VerifyResult,
} from '../types.js';

import {
  commitsTouchingSince,
  isGitRepo,
  lastCommitForFiles,
  lastCommitForPath,
  listTrackedFiles,
  resolveGlobs,
} from './git.js';

const MS_PER_DAY = 86_400_000;

/** Cap on how many changed files we keep in evidence — enough to be convincing. */
const MAX_CHANGED_FILES = 10;

/** Cap on combined stdout+stderr retained from a `verify` run. */
const MAX_VERIFY_OUTPUT = 4096;

const DEFAULT_VERIFY_TIMEOUT_MS = 30_000;

/* -------------------------------------------------------------------------- */
/* Scoring                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Score bands per verdict, as [floor, ceiling].
 *
 * The bands deliberately *overlap* so that the score stays continuous as a doc
 * crosses a verdict boundary. See `driftScore` for why the arithmetic lands
 * exactly on the seams.
 */
const SCORE_BANDS: Record<Freshness, [number, number]> = {
  fresh: [70, 100],
  drifting: [40, 85],
  stale: [10, 55],
  expired: [5, 30],
  orphaned: [3, 20],
  superseded: [0, 10],
  // "unverified" is not a failure — it is an absence of proof. 50 is the honest
  // midpoint: we cannot vouch for the doc, and we cannot condemn it either.
  unverified: [50, 50],
};

/** Half-life decay from `hi` toward `lo`. Continuous, monotone, never negative. */
function decayFrom(hi: number, lo: number, days: number, halfLifeDays: number): number {
  const d = Math.max(0, days);
  return lo + (hi - lo) * Math.pow(0.5, d / halfLifeDays);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * The drift score.
 *
 * Pressure is measured in "stale-thresholds": drift days over `staleDriftDays`
 * plus commits over `staleCommitCount`. One full unit of pressure halves the
 * score.
 *
 *     score = 100 * 0.5 ^ (driftDays/staleDriftDays + commitsSince/staleCommitCount)
 *
 * Why exponential decay rather than a piecewise ramp: doc rot is compounding,
 * not linear. Going from 0 to 15 days behind is a much bigger loss of trust
 * than going from 200 to 215. Decay also guarantees the property the spec
 * demands — the score is strictly monotone in both inputs, so a doc 44 days
 * behind (score ~51) can never tie one 15 days behind (~80) merely because both
 * are labelled `drifting`.
 *
 * Why the constants line up: with the defaults (warn 14, stale 45, 10 commits)
 * the decay produces exactly 100 at zero drift, ~81 at the warn threshold, and
 * exactly 50 at the stale threshold. Those are the seams of the score bands, so
 * clamping into a band is a no-op at every boundary and the curve stays smooth
 * across verdict changes. The bands only bind in the deep tail (a doc 150+ days
 * behind saturates at 10) where "very stale" and "extremely stale" are a
 * distinction without a difference.
 */
function driftScore(driftDays: number, commitsSince: number, config: KontextConfig): number {
  const staleDays = Math.max(1, config.staleDriftDays);
  const staleCommits = Math.max(1, config.staleCommitCount);
  const pd = Math.max(0, driftDays) / staleDays;
  const pc = Math.max(0, commitsSince) / staleCommits;
  return 100 * Math.pow(0.5, pd + pc);
}

/* -------------------------------------------------------------------------- */
/* Formatting helpers (evidence strings)                                       */
/* -------------------------------------------------------------------------- */

function parseISO(value: string | undefined | null): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function wholeDaysBetween(fromMs: number, toMs: number): number {
  return Math.floor((toMs - fromMs) / MS_PER_DAY);
}

function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

function agoPhrase(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

/** `a3f9c21 'rework session refresh', 31 days ago` */
function describeCommit(commit: GitCommitInfo, nowMs: number): string {
  const t = parseISO(commit.date);
  const when = t === null ? 'date unknown' : agoPhrase(wholeDaysBetween(t, nowMs));
  const subject = commit.subject.length > 72 ? `${commit.subject.slice(0, 69)}...` : commit.subject;
  return `${shortSha(commit.sha)} '${subject}', ${when}`;
}

/** Join a list for prose, showing at most `max` before an ellipsis count. */
function joinSample(items: readonly string[], max = 3): string {
  if (items.length === 0) return '';
  if (items.length <= max) return items.join(', ');
  const shown = items.slice(0, max).join(', ');
  return `${shown} (+${items.length - max} more)`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/* -------------------------------------------------------------------------- */
/* Per-run caches                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Git history cannot change while a single run is in flight, so every git
 * answer is memoised. This matters: docs in the same repo overwhelmingly
 * describe the same handful of directories, so `describes: [src/auth/**]`
 * appearing in six docs costs one `git log` invocation, not six.
 */
interface RunCache {
  docCommit: Map<string, GitCommitInfo | null>;
  filesCommit: Map<string, GitCommitInfo | null>;
  since: Map<string, { count: number; files: string[] }>;
  globs: Map<string, { matched: string[]; missingGlobs: string[] }>;
}

function newRunCache(): RunCache {
  return { docCommit: new Map(), filesCommit: new Map(), since: new Map(), globs: new Map() };
}

/** id -> paths of docs that declare `supersedes: [id]`. */
type SupersedeIndex = Map<string, string[]>;

/**
 * Built once per `allDocs` array and cached against that array's identity, so
 * `assessAll` pays for it a single time even though `assessDoc` is public and
 * may be called standalone.
 */
const supersedeIndexCache = new WeakMap<DocRecord[], SupersedeIndex>();

function getSupersedeIndex(allDocs: DocRecord[]): SupersedeIndex {
  const cached = supersedeIndexCache.get(allDocs);
  if (cached) return cached;
  const index: SupersedeIndex = new Map();
  for (const other of allDocs) {
    const supersedes = other.frontmatter.supersedes;
    if (!Array.isArray(supersedes)) continue;
    for (const id of supersedes) {
      if (typeof id !== 'string' || id.length === 0) continue;
      const list = index.get(id);
      if (list) list.push(other.path);
      else index.set(id, [other.path]);
    }
  }
  supersedeIndexCache.set(allDocs, index);
  return index;
}

/* -------------------------------------------------------------------------- */
/* Cached git accessors                                                        */
/* -------------------------------------------------------------------------- */

function cachedDocCommit(root: string, relPath: string, cache: RunCache): GitCommitInfo | null {
  const hit = cache.docCommit.get(relPath);
  if (hit !== undefined) return hit;
  let value: GitCommitInfo | null = null;
  try {
    value = lastCommitForPath(root, relPath);
  } catch {
    value = null;
  }
  cache.docCommit.set(relPath, value);
  return value;
}

function cachedFilesCommit(root: string, files: string[], cache: RunCache): GitCommitInfo | null {
  const key = files.join(' ');
  const hit = cache.filesCommit.get(key);
  if (hit !== undefined) return hit;
  let value: GitCommitInfo | null = null;
  try {
    value = lastCommitForFiles(root, files);
  } catch {
    value = null;
  }
  cache.filesCommit.set(key, value);
  return value;
}

function cachedSince(
  root: string,
  files: string[],
  sinceISO: string,
  cache: RunCache,
): { count: number; files: string[] } {
  const key = `${sinceISO}${files.join(' ')}`;
  const hit = cache.since.get(key);
  if (hit !== undefined) return hit;
  let value: { count: number; files: string[] };
  try {
    value = commitsTouchingSince(root, files, sinceISO);
  } catch {
    value = { count: 0, files: [] };
  }
  cache.since.set(key, value);
  return value;
}

function cachedGlobs(
  root: string,
  globs: string[],
  allFiles: string[],
  cache: RunCache,
): { matched: string[]; missingGlobs: string[] } {
  const key = globs.join(' ');
  const hit = cache.globs.get(key);
  if (hit !== undefined) return hit;
  let value: { matched: string[]; missingGlobs: string[] };
  try {
    value = resolveGlobs(root, globs, allFiles);
  } catch {
    value = { matched: [], missingGlobs: globs.slice() };
  }
  cache.globs.set(key, value);
  return value;
}

/* -------------------------------------------------------------------------- */
/* assessDoc                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A condition that fired, the verdict it argues for, and the score ceiling it
 * imposes. The final verdict is the most severe; the final score is the lowest
 * ceiling. That keeps the two decisions independent — an expired doc whose code
 * has also drifted badly scores worse than one that merely expired.
 */
interface Verdict {
  freshness: Freshness;
  score: number;
}

function assessDocInternal(
  root: string,
  doc: DocRecord,
  config: KontextConfig,
  supersedeIndex: SupersedeIndex,
  allFiles: string[],
  cache: RunCache,
  nowMs: number,
): FreshnessReport {
  const reasons: string[] = [];
  const verdicts: Verdict[] = [];
  const fm = doc.frontmatter;

  const docCommit = cachedDocCommit(root, doc.path, cache);
  const docCommitMs = parseISO(docCommit?.date);
  const docAgeDays = docCommitMs === null ? 0 : Math.max(0, wholeDaysBetween(docCommitMs, nowMs));

  /* --- superseded: another doc explicitly claims to replace this one ------ */
  let supersededBy: string[] | undefined;
  if (typeof fm.id === 'string' && fm.id.length > 0) {
    const replacers = supersedeIndex.get(fm.id);
    if (replacers && replacers.length > 0) {
      supersededBy = replacers.slice();
      verdicts.push({
        freshness: 'superseded',
        score: decayFrom(SCORE_BANDS.superseded[1], SCORE_BANDS.superseded[0], docAgeDays, 90),
      });
      reasons.push(
        `superseded: ${joinSample(replacers)} ${plural(replacers.length, 'declares', 'declare')} ` +
          `\`supersedes: [${fm.id}]\`, so this doc has a designated replacement`,
      );
    }
  }

  /* --- expiry: an explicit date, or a ttl measured from the last commit --- */
  const expiresMs = parseISO(fm.expires);
  if (expiresMs !== null && expiresMs <= nowMs) {
    const daysPast = wholeDaysBetween(expiresMs, nowMs);
    verdicts.push({
      freshness: 'expired',
      score: decayFrom(SCORE_BANDS.expired[1], SCORE_BANDS.expired[0], daysPast, 30),
    });
    reasons.push(
      `expired: \`expires: ${fm.expires}\` passed ${agoPhrase(daysPast)}; ` +
        `the author gave this doc a shelf life and it has run out`,
    );
  } else if (typeof fm.expires === 'string' && expiresMs === null) {
    reasons.push(`\`expires: ${fm.expires}\` is not a parseable date and was ignored`);
  }

  const ttlDays = typeof fm.ttlDays === 'number' && fm.ttlDays > 0 ? fm.ttlDays : null;
  if (ttlDays !== null) {
    if (docCommitMs === null) {
      reasons.push(
        `\`ttlDays: ${ttlDays}\` could not be applied — this file has no commit history to measure from`,
      );
    } else if (docAgeDays > ttlDays) {
      const daysPast = docAgeDays - ttlDays;
      verdicts.push({
        freshness: 'expired',
        score: decayFrom(SCORE_BANDS.expired[1], SCORE_BANDS.expired[0], daysPast, 30),
      });
      reasons.push(
        `expired: \`ttlDays: ${ttlDays}\` exceeded by ${daysPast} ${plural(daysPast, 'day')} — ` +
          `last commit to this doc was ${describeCommit(docCommit as GitCommitInfo, nowMs)}`,
      );
    }
  }

  /* --- the load-bearing claim: describes ---------------------------------- */
  const describes = Array.isArray(fm.describes)
    ? fm.describes.filter((g): g is string => typeof g === 'string' && g.trim().length > 0)
    : [];

  let drift: DriftEvidence | undefined;

  if (describes.length === 0) {
    // Not a failure. The doc simply never made a falsifiable claim, so no
    // amount of git archaeology can prove or disprove it.
    verdicts.push({ freshness: 'unverified', score: SCORE_BANDS.unverified[1] });
    reasons.push(
      'unverified: no `describes` field, so this doc makes no falsifiable claim about source ' +
        'files — staleness can be neither proven nor ruled out. Add `describes: [<globs>]` to make it checkable.',
    );
  } else {
    const { matched, missingGlobs } = cachedGlobs(root, describes, allFiles, cache);

    if (matched.length === 0) {
      // The subject of the doc is gone: deleted, renamed, or moved out from
      // under it. The doc has outlived the thing it was written about.
      drift = {
        docLastCommit: docCommit,
        codeLastCommit: null,
        driftDays: 0,
        commitsSince: 0,
        changedFiles: [],
        matchedFileCount: 0,
        missingGlobs,
      };
      verdicts.push({
        freshness: 'orphaned',
        score: decayFrom(SCORE_BANDS.orphaned[1], SCORE_BANDS.orphaned[0], docAgeDays, 90),
      });
      reasons.push(
        `orphaned: \`describes\` ${plural(describes.length, 'glob')} ${joinSample(describes)} ` +
          `${plural(describes.length, 'matches', 'match')} zero tracked files — the code this doc ` +
          `describes was deleted, renamed, or moved`,
      );
    } else if (docCommitMs === null || docCommit === null) {
      // The doc itself is untracked or newly added, so there is no "since"
      // to measure drift from. Honest answer: unverified, not fresh.
      drift = {
        docLastCommit: null,
        codeLastCommit: cachedFilesCommit(root, matched, cache),
        driftDays: 0,
        commitsSince: 0,
        changedFiles: [],
        matchedFileCount: matched.length,
        missingGlobs,
      };
      verdicts.push({ freshness: 'unverified', score: SCORE_BANDS.unverified[1] });
      reasons.push(
        `unverified: \`describes\` resolves to ${matched.length} tracked ${plural(matched.length, 'file')}, ` +
          `but this doc has no commit history of its own (untracked or never committed), so there is ` +
          `no baseline to measure drift from`,
      );
    } else {
      const codeCommit = cachedFilesCommit(root, matched, cache);
      const codeCommitMs = parseISO(codeCommit?.date);

      // If the described code's newest commit predates the doc, nothing can
      // have touched it since — skip the third git call entirely. On a repo of
      // mostly-fresh docs this halves the process count.
      const codeLeads = codeCommitMs !== null && codeCommitMs > docCommitMs;
      // git's `--since` is inclusive, which would count the doc's *own* commit
      // whenever a single commit updated both the doc and the code it
      // describes. That is the opposite of drift — the author kept them in
      // sync — so measure strictly after the doc's timestamp.
      const sinceISO = new Date(docCommitMs + 1000).toISOString();
      const since = codeLeads
        ? cachedSince(root, matched, sinceISO, cache)
        : { count: 0, files: [] };

      const driftDays = codeCommitMs === null ? 0 : wholeDaysBetween(docCommitMs, codeCommitMs);
      const commitsSince = since.count;

      drift = {
        docLastCommit: docCommit,
        codeLastCommit: codeCommit,
        driftDays,
        commitsSince,
        changedFiles: since.files.slice(0, MAX_CHANGED_FILES),
        matchedFileCount: matched.length,
        missingGlobs,
      };

      // Threshold ladder. `staleCommitCount` is an independent trigger: a burst
      // of commits inside the warn window is still churn the doc has not seen.
      const warnCommits = Math.max(2, Math.ceil(Math.max(1, config.staleCommitCount) / 2));
      let verdict: Freshness;
      if (driftDays >= config.staleDriftDays || commitsSince >= config.staleCommitCount) {
        verdict = 'stale';
      } else if (driftDays >= config.warnDriftDays || commitsSince >= warnCommits) {
        verdict = 'drifting';
      } else {
        verdict = 'fresh';
      }

      const band = SCORE_BANDS[verdict];
      let score = clamp(driftScore(driftDays, commitsSince, config), band[0], band[1]);

      // A doc whose globs are partly dead is partly wrong even if the surviving
      // files are quiet. Scale the score by how much of its subject still exists.
      if (missingGlobs.length > 0) {
        const missingRatio = missingGlobs.length / describes.length;
        score *= 1 - 0.5 * missingRatio;
        reasons.push(
          `${missingGlobs.length} of ${describes.length} \`describes\` ${plural(describes.length, 'glob')} ` +
            `${plural(missingGlobs.length, 'matches', 'match')} no files (${joinSample(missingGlobs)}) — ` +
            `score reduced ${Math.round(50 * missingRatio)}%`,
        );
      }

      verdicts.push({ freshness: verdict, score });

      // Evidence, tailored to what actually happened.
      const globList = joinSample(describes);
      if (verdict === 'fresh') {
        reasons.push(
          `fresh: no commits touched the ${matched.length} ${plural(matched.length, 'file')} matched by ` +
            `${globList} since this doc was last updated` +
            (docCommit ? ` (doc: ${describeCommit(docCommit, nowMs)})` : ''),
        );
      } else {
        const parts: string[] = [];
        if (commitsSince > 0) {
          parts.push(
            `${commitsSince} ${plural(commitsSince, 'commit')} touched ${globList} since this doc was ` +
              `last updated` +
              (codeCommit ? ` (latest: ${describeCommit(codeCommit, nowMs)})` : ''),
          );
        }
        if (driftDays > 0) {
          parts.push(
            `the described code is ${driftDays} ${plural(driftDays, 'day')} ahead of the doc ` +
              `(doc: ${describeCommit(docCommit, nowMs)})`,
          );
        }
        if (parts.length === 0) {
          parts.push(
            `the described code moved after this doc was last updated (doc: ${describeCommit(docCommit, nowMs)})`,
          );
        }
        const threshold =
          verdict === 'stale'
            ? driftDays >= config.staleDriftDays
              ? `past the ${config.staleDriftDays}-day stale threshold`
              : `past the ${config.staleCommitCount}-commit stale threshold`
            : driftDays >= config.warnDriftDays
              ? `past the ${config.warnDriftDays}-day warn threshold`
              : `past the ${warnCommits}-commit warn threshold`;
        reasons.push(`${verdict}: ${parts.join('; ')} — ${threshold}`);
        if (since.files.length > 0) {
          reasons.push(
            `files that moved: ${joinSample(since.files, MAX_CHANGED_FILES)}`,
          );
        }
      }
    }
  }

  /* --- resolve: worst verdict wins, lowest score ceiling wins ------------- */
  let freshness: Freshness = 'fresh';
  let score = 100;
  for (const v of verdicts) {
    if (FRESHNESS_SEVERITY[v.freshness] > FRESHNESS_SEVERITY[freshness]) freshness = v.freshness;
    if (v.score < score) score = v.score;
  }
  if (verdicts.length === 0) {
    // Defensive: `describes` always pushes exactly one verdict, so this is
    // unreachable, but a silent 100 with no reason would violate rule 1.
    reasons.push('fresh: no staleness signal fired for this doc');
  }
  if (verdicts.length > 1) {
    reasons.push(
      `${verdicts.length} conditions applied; the most severe (\`${freshness}\`) sets the verdict`,
    );
  }

  const report: FreshnessReport = {
    doc,
    freshness,
    score: clamp(Math.round(score), 0, 100),
    reasons,
  };
  if (drift) report.drift = drift;
  if (supersededBy) report.supersededBy = supersededBy;
  return report;
}

/**
 * Assess one document. `allDocs` supplies the supersedes graph; `allFiles`
 * should be the repo's tracked file list (see `assessAll`, which fetches it
 * once for the whole run).
 */
export function assessDoc(
  root: string,
  doc: DocRecord,
  config: KontextConfig,
  allDocs: DocRecord[],
  allFiles: string[],
): FreshnessReport {
  return assessDocInternal(
    root,
    doc,
    config,
    getSupersedeIndex(allDocs),
    allFiles,
    newRunCache(),
    Date.now(),
  );
}

/**
 * Assess every document in one pass.
 *
 * The tracked-file list is fetched exactly once and threaded down, and all git
 * lookups share a run-scoped memo. A 300-doc repo costs one `git ls-files` plus
 * at most three `git log` calls per doc that actually declares `describes`,
 * with identical glob sets and identical paths deduplicated.
 */
export function assessAll(
  root: string,
  docs: DocRecord[],
  config: KontextConfig,
): FreshnessReport[] {
  let allFiles: string[] = [];
  let repo = false;
  try {
    repo = isGitRepo(root);
    if (repo) allFiles = listTrackedFiles(root);
  } catch {
    repo = false;
  }

  const index = getSupersedeIndex(docs);
  const cache = newRunCache();
  const nowMs = Date.now();

  if (!repo) {
    // Without git there is no witness, so no doc can be proven stale. Say that
    // out loud rather than reporting a repo full of `fresh`.
    return docs.map((doc) => ({
      doc,
      freshness: 'unverified' as Freshness,
      score: SCORE_BANDS.unverified[1],
      reasons: [
        `unverified: ${root} is not a git repository, so there is no commit history to check ` +
          `\`describes\` claims against`,
      ],
    }));
  }

  return docs.map((doc) =>
    assessDocInternal(root, doc, config, index, allFiles, cache, nowMs),
  );
}

/* -------------------------------------------------------------------------- */
/* runVerify                                                                   */
/* -------------------------------------------------------------------------- */

/** Characters that mean the string is a shell program, not a bare argv. */
const SHELL_METACHARS = /[|&;<>()$`\\"'*?\[\]{}~\n]/;

/**
 * Split a simple command into argv. Returns null when the string needs a real
 * shell (pipes, redirects, globs, substitutions), in which case the caller
 * falls back to `sh -c`.
 */
function parseCommand(command: string): { file: string; args: string[] } | null {
  if (SHELL_METACHARS.test(command)) return null;
  const parts = command.trim().split(/\s+/).filter((p) => p.length > 0);
  const file = parts[0];
  if (file === undefined) return null;
  return { file, args: parts.slice(1) };
}

function capOutput(text: string): string {
  if (text.length <= MAX_VERIFY_OUTPUT) return text;
  return `${text.slice(0, MAX_VERIFY_OUTPUT)}\n... [output truncated at ${MAX_VERIFY_OUTPUT} bytes]`;
}

/**
 * Run a doc's `verify` command — the strongest possible freshness signal, since
 * a passing test proves the doc's claim rather than merely dating it.
 *
 * Returns null when the doc declares no `verify`. Never throws and never hangs:
 * the child is spawned synchronously with a hard timeout and SIGKILL, output is
 * capped, and every failure mode (missing binary, non-zero exit, timeout) comes
 * back as a `VerifyResult` rather than an exception.
 *
 * Implementation note: this uses `spawnSync`, which is `execFileSync` without
 * the throw-on-nonzero-exit behaviour — a failing verify is the *expected* case
 * here, and spawnSync is the only sync variant that hands back stdout and
 * stderr together in that case. `shell: false` is the default; a shell is only
 * introduced (as an explicit `sh -c` argv) when the command genuinely needs one.
 */
export function runVerify(
  root: string,
  doc: DocRecord,
  timeoutMs: number = DEFAULT_VERIFY_TIMEOUT_MS,
): VerifyResult | null {
  const command = doc.frontmatter.verify;
  if (typeof command !== 'string' || command.trim().length === 0) return null;
  const trimmed = command.trim();

  const parsed = parseCommand(trimmed);
  const file = parsed ? parsed.file : '/bin/sh';
  const args = parsed ? parsed.args : ['-c', trimmed];

  const started = Date.now();
  try {
    const result = spawnSync(file, args, {
      cwd: root,
      timeout: Math.max(1, timeoutMs),
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const durationMs = Date.now() - started;
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    let output = `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`.trim();

    if (result.error) {
      const err = result.error as NodeJS.ErrnoException;
      const note =
        err.code === 'ETIMEDOUT'
          ? `verify timed out after ${timeoutMs}ms and was killed`
          : `verify could not be run: ${err.message}`;
      return {
        command: trimmed,
        passed: false,
        exitCode: -1,
        durationMs,
        output: capOutput(output ? `${note}\n${output}` : note),
      };
    }

    if (result.signal) {
      return {
        command: trimmed,
        passed: false,
        exitCode: -1,
        durationMs,
        output: capOutput(
          `verify was terminated by signal ${result.signal}${output ? `\n${output}` : ''}`,
        ),
      };
    }

    const exitCode = typeof result.status === 'number' ? result.status : -1;
    if (!output) output = exitCode === 0 ? '(no output)' : '(no output)';
    return {
      command: trimmed,
      passed: exitCode === 0,
      exitCode,
      durationMs,
      output: capOutput(output),
    };
  } catch (err) {
    // spawnSync should not throw, but a bad cwd or an exotic platform can.
    return {
      command: trimmed,
      passed: false,
      exitCode: -1,
      durationMs: Date.now() - started,
      output: capOutput(`verify could not be run: ${(err as Error).message}`),
    };
  }
}
