/**
 * Git interrogation — the evidence layer.
 *
 * Everything kontext claims about staleness ultimately comes from here, so two
 * properties matter more than features:
 *
 *   Safety. Git is invoked with `execFileSync('git', [...])` — an argv array,
 *   never a shell string. Doc paths and globs come from user frontmatter, and
 *   a doc named `$(rm -rf ~).md` must be exactly as boring as any other. Paths
 *   are additionally passed after `--` and wrapped in `:(literal)` pathspec
 *   magic, so a filename starting with `-` cannot be read as a flag and a
 *   filename containing `*` cannot be read as a wildcard.
 *
 *   Honesty about absence. A repo with no commits, a doc that was never
 *   committed, a directory that is not a repo at all — these are normal states
 *   for a tool people run on day one, not errors. Every function returns null
 *   or an empty result instead of throwing.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { matchGlob } from '../util/glob.js';
import type { GitCommitInfo } from '../types.js';

/**
 * ASCII unit/record separators. Commit subjects contain newlines, pipes, tabs
 * and quotes; these two bytes do not appear in git metadata, so they are the
 * only delimiters that parse correctly on a real repository's history.
 */
const FIELD = '\x1f';
const RECORD = '\x1e';

/** Leading RECORD per commit makes splitting unambiguous even with --name-only. */
const LOG_FORMAT = `--pretty=format:${RECORD}%H${FIELD}%aI${FIELD}%s${FIELD}%an`;

/** argv is finite; long doc sets are chunked rather than blowing up ARG_MAX. */
const MAX_PATHSPECS = 200;

/** Git can block on locks or a slow filesystem; a scan must not hang forever. */
const GIT_TIMEOUT_MS = 20_000;

/** Sample size for "which files moved" — a readable list, not an audit log. */
const MAX_CHANGED_FILES = 20;

/** True if `root` is inside a git work tree. */
export function isGitRepo(root: string): boolean {
  // The cheap check first: `.git` is a directory in a normal clone and a file
  // in a worktree or submodule.
  if (existsSync(join(root, '.git'))) return true;
  const out = run(root, ['rev-parse', '--is-inside-work-tree']);
  return out !== null && out.trim() === 'true';
}

/**
 * The last commit that touched one path, or null when the path has no history
 * (untracked, newly created, or the repo has no commits yet).
 *
 * Rename history is deliberately not followed: `--follow` only accepts a
 * single pathspec, so using it here would make single-path and multi-path
 * results inconsistent — and a doc whose subject was renamed *should* look
 * suspicious rather than silently inheriting the old file's history.
 */
export function lastCommitForPath(root: string, relPath: string): GitCommitInfo | null {
  if (typeof relPath !== 'string' || relPath.trim().length === 0) return null;
  return lastCommitForFiles(root, [relPath]);
}

/** The most recent commit touching any of `relPaths`. */
export function lastCommitForFiles(
  root: string,
  relPaths: string[],
): GitCommitInfo | null {
  const paths = cleanPaths(relPaths);
  if (paths.length === 0) return null;

  let newest: GitCommitInfo | null = null;
  for (const chunk of chunkArray(paths, MAX_PATHSPECS)) {
    const out = run(root, ['log', '-1', LOG_FORMAT, '--', ...pathspecs(chunk)]);
    if (out === null) continue;
    const commits = parseLog(out);
    const first = commits[0];
    if (!first) continue;
    // Chunking means we see one "latest" per chunk; keep the true maximum.
    if (newest === null || compareDates(first.info.date, newest.date) > 0) {
      newest = first.info;
    }
  }
  return newest;
}

/**
 * How much has moved under `relPaths` since `sinceISO`.
 *
 * `count` is the number of commits — that is what `DriftEvidence.commitsSince`
 * reports and what the stale-by-churn threshold compares against. `files` is a
 * deduplicated sample capped at 20 for display; the honest total is `count`
 * commits, and the file list never claims to be exhaustive.
 *
 * Filtering is by commit date (`--since`), not author date: rebases and
 * cherry-picks rewrite author dates backwards, which would let a burst of
 * freshly landed churn disappear from the evidence.
 */
export function commitsTouchingSince(
  root: string,
  relPaths: string[],
  sinceISO: string,
): { count: number; files: string[] } {
  const empty = { count: 0, files: [] as string[] };
  const paths = cleanPaths(relPaths);
  if (paths.length === 0) return empty;
  if (typeof sinceISO !== 'string' || Number.isNaN(Date.parse(sinceISO))) return empty;

  const seenCommits = new Set<string>();
  const seenFiles = new Set<string>();

  for (const chunk of chunkArray(paths, MAX_PATHSPECS)) {
    const out = run(root, [
      'log',
      `--since=${sinceISO}`,
      '--name-only',
      LOG_FORMAT,
      '--',
      ...pathspecs(chunk),
    ]);
    if (out === null) continue;

    for (const commit of parseLog(out)) {
      // Chunks overlap in history, so dedupe by sha or the count inflates.
      if (seenCommits.has(commit.info.sha)) continue;
      seenCommits.add(commit.info.sha);
      for (const file of commit.files) seenFiles.add(file);
    }
  }

  return {
    count: seenCommits.size,
    files: [...seenFiles].sort().slice(0, MAX_CHANGED_FILES),
  };
}

/**
 * Resolve `describes:` globs against a known file list.
 *
 * `missingGlobs` is the orphan signal: a glob that matches nothing means the
 * code the doc describes was deleted, renamed or never existed, and the doc is
 * now making a claim about nothing. A glob with no wildcards is also checked
 * against the working tree, so a real-but-untracked file counts as matched
 * rather than being reported as an orphan on day one.
 */
export function resolveGlobs(
  root: string,
  globs: string[],
  allFiles: string[],
): { matched: string[]; missingGlobs: string[] } {
  const matched = new Set<string>();
  const missingGlobs: string[] = [];

  if (!Array.isArray(globs) || globs.length === 0) {
    return { matched: [], missingGlobs: [] };
  }
  const files = Array.isArray(allFiles) ? allFiles : [];

  for (const glob of globs) {
    if (typeof glob !== 'string' || glob.trim().length === 0) continue;
    const pattern = glob.trim();

    let hit = false;
    for (const file of files) {
      if (matchGlob(pattern, file)) {
        matched.add(file);
        hit = true;
      }
    }

    if (!hit && !hasMagic(pattern) && existsOnDisk(root, pattern)) {
      matched.add(normalize(pattern));
      hit = true;
    }
    if (!hit) missingGlobs.push(pattern);
  }

  return { matched: [...matched].sort(), missingGlobs };
}

/**
 * Every file git tracks, as repo-relative POSIX paths. Empty for a
 * non-repository or a repo with nothing staged or committed.
 */
export function listTrackedFiles(root: string): string[] {
  // -z avoids git's quoting of paths with spaces or non-ASCII characters.
  const out = run(root, ['ls-files', '-z']);
  if (out === null) return [];
  return out.split('\0').filter((path) => path.length > 0);
}

/* ------------------------------------------------------------------ *
 * Process plumbing
 * ------------------------------------------------------------------ */

/**
 * Run git, returning stdout or null on any failure.
 *
 * `--no-pager` because a pager on a TTY would hang the scan; `core.quotepath=false`
 * so unicode paths come back verbatim; `log.showSignature=false` so a repo that
 * signs commits does not interleave gpg output into the record stream;
 * `GIT_OPTIONAL_LOCKS=0` so a read-only scan never fights an open editor for
 * the index lock.
 */
function run(root: string, args: string[]): string | null {
  try {
    return execFileSync(
      'git',
      ['--no-pager', '-c', 'core.quotepath=false', '-c', 'log.showSignature=false', ...args],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      },
    );
  } catch {
    // git missing, not a repo, no commits yet, bad path, timeout — all of
    // these mean the same thing to a caller: no evidence available.
    return null;
  }
}

interface LogRecord {
  info: GitCommitInfo;
  files: string[];
}

/** Parse the RECORD/FIELD stream produced by LOG_FORMAT (with or without --name-only). */
function parseLog(out: string): LogRecord[] {
  const records: LogRecord[] = [];

  for (const chunk of out.split(RECORD)) {
    if (chunk.trim().length === 0) continue;

    const newline = chunk.indexOf('\n');
    const header = newline === -1 ? chunk : chunk.slice(0, newline);
    const rest = newline === -1 ? '' : chunk.slice(newline + 1);

    const fields = header.split(FIELD);
    const sha = fields[0];
    if (!sha || sha.length < 7) continue; // not a commit header; ignore

    records.push({
      info: {
        sha,
        date: fields[1] ?? '',
        subject: fields[2] ?? '',
        author: fields[3] ?? '',
      },
      files: rest
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    });
  }

  return records;
}

/* ------------------------------------------------------------------ *
 * Path helpers
 * ------------------------------------------------------------------ */

/**
 * `:(literal)` disables git's own pathspec globbing, so a file literally named
 * `docs/[draft].md` resolves to itself instead of a character class.
 */
function pathspecs(paths: string[]): string[] {
  return paths.map((path) => `:(literal)${path}`);
}

function cleanPaths(relPaths: string[]): string[] {
  if (!Array.isArray(relPaths)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of relPaths) {
    if (typeof path !== 'string') continue;
    const normalized = normalize(path);
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalize(path: string): string {
  let p = path.replace(/\\/g, '/').trim();
  while (p.startsWith('./')) p = p.slice(2);
  if (p.startsWith('/')) p = p.slice(1);
  return p;
}

function hasMagic(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}

function existsOnDisk(root: string, relPath: string): boolean {
  try {
    return existsSync(join(root, normalize(relPath)));
  } catch {
    return false;
  }
}

/** ISO dates sort lexically, but fall back to Date parsing for odd offsets. */
function compareDates(a: string, b: string): number {
  const timeA = Date.parse(a);
  const timeB = Date.parse(b);
  if (Number.isNaN(timeA) || Number.isNaN(timeB)) return a < b ? -1 : a > b ? 1 : 0;
  return timeA - timeB;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length <= size) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
