/**
 * Scan + assessment cache for the kontext MCP server.
 *
 * Scanning a repo and running git archaeology over every doc is far too slow to
 * repeat on every tool call — an agent may fire `kontext_search`,
 * `kontext_freshness` and `kontext_read` back to back within one turn.
 *
 * The cache is validated against a *cheap* signature rather than a timer alone:
 *
 *   git HEAD sha  +  working-tree dirty count  +  doc count  +  missing-file
 *   count  +  max mtime across known doc files and their directories  +  config
 *   file mtime
 *
 * A commit, an edit, a rename, or a config change all move that signature, so a
 * hit means "nothing observable changed". A 30 second TTL is kept as a backstop
 * for the one thing the signature cannot see cheaply: a brand new doc created in
 * a directory we have never scanned.
 *
 * Nothing in this module writes to stdout — stdout is the MCP protocol channel.
 */

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import * as path from 'node:path';

import type { DocRecord, FreshnessReport, KontextConfig } from '../types.js';
import { loadConfig } from '../core/config.js';
import { scanDocs } from '../core/scan.js';
import { assessAll } from '../core/freshness.js';

/** A fully built, ready-to-serve view of the repo's context corpus. */
export interface KontextState {
  root: string;
  config: KontextConfig;
  docs: DocRecord[];
  reports: FreshnessReport[];
  /** Epoch ms at which this state was built. */
  builtAt: number;
  /** The invalidation signature this state was built under. */
  signature: string;
  /** True when this call rebuilt rather than served from cache. */
  rebuilt: boolean;
  /** Wall time of the build that produced this state, in ms. */
  buildMs: number;
}

/** Backstop TTL. Even a matching signature is distrusted after this long. */
export const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  state: KontextState;
}

const CACHE = new Map<string, CacheEntry>();

/**
 * Builds in progress, keyed by root. Agents routinely fire several kontext
 * tools in one turn; without this they would each pay for a full cold scan.
 */
const INFLIGHT = new Map<string, Promise<KontextState>>();

/** Candidate config filenames whose mtime should bust the cache. */
const CONFIG_FILES = ['kontext.config.json', '.kontextrc', '.kontextrc.json', 'kontext.json'];

/**
 * Run a git command and capture stdout. Returns null on any failure.
 * stdio is fully piped so git can never write to our stdout.
 */
export function gitQuery(root: string, args: string[]): string | null {
  try {
    const res = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (res.error !== undefined || res.status !== 0) return null;
    if (typeof res.stdout !== 'string') return null;
    return res.stdout.trim();
  } catch {
    return null;
  }
}

function mtimeOf(target: string): number {
  try {
    return statSync(target).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * Compute the invalidation signature for a known set of docs.
 *
 * Cheap by design: one `git rev-parse` plus a stat per doc and per containing
 * directory. Directory mtimes catch creates and deletes within already-known
 * directories; the TTL catches everything else.
 */
function computeSignature(root: string, docs: DocRecord[]): string {
  const head = gitQuery(root, ['rev-parse', 'HEAD']) ?? 'no-head';
  const dirty = gitQuery(root, ['status', '--porcelain', '--untracked-files=no']);
  const dirtyLines = dirty === null ? -1 : dirty === '' ? 0 : dirty.split('\n').length;

  let maxMtime = 0;
  let missing = 0;
  const dirs = new Set<string>([root]);

  for (const doc of docs) {
    const abs = path.resolve(root, doc.path);
    dirs.add(path.dirname(abs));
    const m = mtimeOf(abs);
    if (m < 0) missing += 1;
    else if (m > maxMtime) maxMtime = m;
  }

  for (const dir of dirs) {
    const m = mtimeOf(dir);
    if (m > maxMtime) maxMtime = m;
  }

  let configMtime = 0;
  for (const name of CONFIG_FILES) {
    const m = mtimeOf(path.join(root, name));
    if (m > configMtime) configMtime = m;
  }

  return [head, dirtyLines, docs.length, missing, Math.round(maxMtime), Math.round(configMtime)].join('|');
}

async function build(root: string): Promise<KontextState> {
  const started = Date.now();
  const config = loadConfig(root);
  const docs = await scanDocs(root, config);
  const reports = assessAll(root, docs, config);
  const signature = computeSignature(root, docs);
  return {
    root,
    config,
    docs,
    reports,
    builtAt: Date.now(),
    signature,
    rebuilt: true,
    buildMs: Date.now() - started,
  };
}

/**
 * Get the current corpus state for a repo root, rebuilding only when the
 * signature moved, the TTL lapsed, or `force` was requested.
 *
 * Throws whatever the core layers throw (e.g. "not a git repository"); callers
 * are expected to turn that into a structured tool error.
 */
export async function getState(root: string, opts: { force?: boolean } = {}): Promise<KontextState> {
  const cached = CACHE.get(root);

  if (cached !== undefined && opts.force !== true) {
    const age = Date.now() - cached.state.builtAt;
    if (age < CACHE_TTL_MS) {
      const signature = computeSignature(root, cached.state.docs);
      if (signature === cached.state.signature) {
        return { ...cached.state, rebuilt: false };
      }
    }
  }

  const pending = INFLIGHT.get(root);
  if (pending !== undefined) {
    const state = await pending;
    return { ...state, rebuilt: false };
  }

  const started = build(root)
    .then((state) => {
      CACHE.set(root, { state });
      return state;
    })
    .finally(() => {
      INFLIGHT.delete(root);
    });
  INFLIGHT.set(root, started);
  return started;
}

/** Drop the cached state for a root (or for every root when omitted). */
export function invalidate(root?: string): void {
  if (root === undefined) CACHE.clear();
  else CACHE.delete(root);
}

/** Introspection for the startup banner and diagnostics. Never touches stdout. */
export function cacheStats(root: string): { cached: boolean; ageMs: number; docCount: number } {
  const entry = CACHE.get(root);
  if (entry === undefined) return { cached: false, ageMs: -1, docCount: 0 };
  return {
    cached: true,
    ageMs: Date.now() - entry.state.builtAt,
    docCount: entry.state.docs.length,
  };
}
