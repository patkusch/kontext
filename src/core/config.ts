/**
 * Configuration loading.
 *
 * `kontext.config.json` is optional and every field in it is optional. A repo
 * with no config file, an empty config file, or a config file full of nonsense
 * must all produce a working `KontextConfig` — the tool is most useful on the
 * repo that has never heard of it, so it cannot demand setup to run.
 *
 * Invalid values are replaced by the default and reported on stderr. stderr,
 * not stdout, because `kontext pack --json` output gets piped into agents and
 * a warning in the middle of that stream would corrupt it.
 */

import { homedir } from 'node:os';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_CONFIG, FRESHNESS_SEVERITY } from '../types.js';
import type { Freshness, KontextConfig } from '../types.js';

export const CONFIG_FILENAME = 'kontext.config.json';

/** Valid `Freshness` values, derived from the severity table so they can't drift. */
const FRESHNESS_VALUES = Object.keys(FRESHNESS_SEVERITY) as Freshness[];

/**
 * Load config from `<root>/kontext.config.json`, merged over `DEFAULT_CONFIG`.
 *
 * "Deep merge" here means field-wise: a config that sets only `staleDriftDays`
 * keeps every default around it. Arrays *replace* rather than concatenate —
 * a user who writes `include: ["docs/**\/*.md"]` means only docs, and silently
 * unioning in the default `**\/*.md` would scan the whole repo anyway. The one
 * exception is `exclude`, where the defaults (`node_modules`, `.git`, `dist`)
 * are always kept: nobody means "please walk node_modules", and forgetting to
 * repeat those is the single most common config mistake.
 */
export function loadConfig(root: string): KontextConfig {
  const config: KontextConfig = {
    ...DEFAULT_CONFIG,
    include: [...DEFAULT_CONFIG.include],
    exclude: [...DEFAULT_CONFIG.exclude],
    failOn: [...DEFAULT_CONFIG.failOn],
  };

  const configPath = join(root, CONFIG_FILENAME);
  if (!fileExists(configPath)) return config;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    warn(`${CONFIG_FILENAME} is not valid JSON (${errorMessage(error)}); using defaults`);
    return config;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn(`${CONFIG_FILENAME} must contain a JSON object; using defaults`);
    return config;
  }

  const raw = parsed as Record<string, unknown>;

  const include = stringArray(raw['include'], 'include');
  if (include && include.length > 0) config.include = include;
  else if (include) warn('include: empty list would match no docs; using defaults');

  const exclude = stringArray(raw['exclude'], 'exclude');
  if (exclude) {
    // Union, deduped, defaults first — see the note above.
    config.exclude = [...new Set([...DEFAULT_CONFIG.exclude, ...exclude])];
  }

  config.warnDriftDays = positiveNumber(
    raw['warnDriftDays'],
    'warnDriftDays',
    DEFAULT_CONFIG.warnDriftDays,
  );
  config.staleDriftDays = positiveNumber(
    raw['staleDriftDays'],
    'staleDriftDays',
    DEFAULT_CONFIG.staleDriftDays,
  );
  config.staleCommitCount = positiveNumber(
    raw['staleCommitCount'],
    'staleCommitCount',
    DEFAULT_CONFIG.staleCommitCount,
  );
  config.defaultPackBudget = positiveNumber(
    raw['defaultPackBudget'],
    'defaultPackBudget',
    DEFAULT_CONFIG.defaultPackBudget,
  );

  // A warn threshold above the stale threshold makes `drifting` unreachable,
  // which looks like the tool is broken rather than misconfigured.
  if (config.warnDriftDays > config.staleDriftDays) {
    warn(
      `warnDriftDays (${config.warnDriftDays}) is greater than staleDriftDays (${config.staleDriftDays}); using ${config.staleDriftDays} for both`,
    );
    config.warnDriftDays = config.staleDriftDays;
  }

  if ('failOn' in raw) {
    const failOn = stringArray(raw['failOn'], 'failOn');
    if (failOn) {
      const valid: Freshness[] = [];
      for (const item of failOn) {
        if ((FRESHNESS_VALUES as string[]).includes(item)) valid.push(item as Freshness);
        else
          warn(
            `failOn: '${item}' is not a freshness verdict (expected one of ${FRESHNESS_VALUES.join(', ')}); ignoring it`,
          );
      }
      // An explicitly empty failOn is meaningful: "never fail CI".
      config.failOn = valid;
    }
  }

  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULT_CONFIG)) {
      warn(`${CONFIG_FILENAME}: unknown option '${key}' ignored`);
    }
  }

  return config;
}

/**
 * Walk up from `startDir` looking for `.git`, falling back to `startDir`.
 *
 * `.git` may be a directory or, inside a worktree or submodule, a file — both
 * count. Falling back rather than failing keeps kontext usable on a plain
 * folder of markdown that was never a repo; the git layer degrades to null
 * from there and staleness simply reports as `unverified`.
 */
export function findRepoRoot(startDir: string): string {
  let dir: string;
  try {
    dir = resolve(startDir);
  } catch {
    return startDir;
  }

  const start = dir;
  // Bounded so a pathological symlinked path can never spin forever.
  for (let depth = 0; depth < 100; depth++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return start;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Null when the value is absent or not an array of strings. */
function stringArray(value: unknown, key: string): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    warn(`${key}: expected a list of strings; using the default`);
    return null;
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim().length > 0) out.push(item.trim());
    else warn(`${key}: ignoring non-string entry ${JSON.stringify(item)}`);
  }
  return out;
}

function positiveNumber(value: unknown, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    warn(`${key}: ${JSON.stringify(value)} is not a positive number; using ${fallback}`);
    return fallback;
  }
  return value;
}

function warn(message: string): void {
  try {
    process.stderr.write(`kontext: warning: ${message}\n`);
  } catch {
    // A closed stderr (piped into a dead process) must not crash a scan.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Documents above this count in one "repo" almost always means the root
 * resolved wider than the user intended — a project folder with no `.git` of
 * its own, so the walk upward kept going.
 */
export const WIDE_SCOPE_DOC_COUNT = 400;

/**
 * True when the resolved root is the user's home directory.
 *
 * This happens when a project folder has no `.git` and some ancestor does —
 * `git init` in $HOME is a surprisingly common accident. Reading is merely
 * slow; *writing* would rewrite every markdown file the user owns, so any
 * destructive command must refuse here unless explicitly overridden.
 */
export function isHomeDirRoot(root: string): boolean {
  try {
    return resolve(root) === resolve(homedir());
  } catch {
    return false;
  }
}
