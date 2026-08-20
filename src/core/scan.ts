/**
 * Filesystem scan: markdown in, `DocRecord`s out.
 *
 * The walk prunes excluded directories on the way down rather than filtering
 * paths on the way out. That is not a micro-optimisation — descending into
 * `node_modules` on a real repo means tens of thousands of README files and a
 * scan that takes minutes instead of milliseconds. `node_modules` and `.git`
 * are additionally hard-blocked by name so that no amount of config editing
 * can talk kontext into walking them.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import { parseFrontmatter, validateFrontmatter } from './frontmatter.js';
import { matchAny } from '../util/glob.js';
import { estimateTokens } from '../util/tokens.js';
import type { DocRecord, KontextConfig } from '../types.js';

/** Files above this are not docs — they are data, and reading them stalls scans. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Depth guard against pathological or symlink-looped trees. */
const MAX_DEPTH = 32;

/** Directories that are never worth descending into, config notwithstanding. */
const ALWAYS_PRUNE = new Set(['.git', 'node_modules']);

/**
 * A sentinel child path used to ask "would everything under this directory be
 * excluded?". Testing `dist/__probe__` against `**\/dist/**` prunes the whole
 * tree, while `**\/dist/*.md` correctly does not prune it (only its direct .md
 * children are excluded, and deeper docs still count).
 */
const PROBE = '__kontext_probe__';

/** Fenced-code detection, so a `# comment` inside a shell block is not a heading. */
const FENCE_RE = /^\s{0,3}(?:`{3,}|~{3,})/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * Walk `root` and read every doc matching `config.include` minus
 * `config.exclude`. Unreadable directories, binary files and oversized files
 * are skipped silently: a scan over someone else's repo reports on what it can
 * read and never fails because of what it cannot.
 *
 * Results are sorted by path so output is stable across platforms and runs.
 */
export async function scanDocs(
  root: string,
  config: KontextConfig,
): Promise<DocRecord[]> {
  const include = config?.include ?? [];
  const exclude = config?.exclude ?? [];

  const files: string[] = [];
  await walk(root, '', 0, exclude, include, files);
  files.sort();

  const docs: DocRecord[] = [];
  for (const relPath of files) {
    const result = await readDocInternal(root, relPath);
    // Oversized/binary/unreadable files were already filtered by the walk in
    // most cases; this catches races (file deleted mid-scan) too.
    if (result.skipped) continue;
    docs.push(result.record);
  }
  return docs;
}

/**
 * Read and parse a single doc by repo-relative path.
 *
 * Always returns a record, even for a missing or unreadable file — callers
 * that asked for a specific path want a usable object with an empty body, not
 * an exception to catch. `hasFrontmatter: false` plus an empty body is the
 * signal that nothing could be read.
 */
export async function readDoc(root: string, relPath: string): Promise<DocRecord> {
  const { record } = await readDocInternal(root, relPath);
  return record;
}

/* ------------------------------------------------------------------ *
 * Walk
 * ------------------------------------------------------------------ */

async function walk(
  root: string,
  relDir: string,
  depth: number,
  exclude: string[],
  include: string[],
  out: string[],
): Promise<void> {
  if (depth > MAX_DEPTH) return;

  let entries;
  try {
    entries = await readdir(join(root, relDir), { withFileTypes: true });
  } catch {
    return; // permission denied, deleted mid-walk, or not a directory
  }

  for (const entry of entries) {
    const name = entry.name;
    const rel = relDir.length > 0 ? `${relDir}/${name}` : name;

    // Symlinks are skipped entirely: following them risks cycles and lets a
    // scan wander outside the repo, where git can prove nothing anyway.
    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      if (ALWAYS_PRUNE.has(name)) continue;
      if (isDirExcluded(rel, exclude)) continue;
      await walk(root, rel, depth + 1, exclude, include, out);
      continue;
    }

    if (!entry.isFile()) continue; // sockets, fifos, devices
    if (!matchAny(include, rel)) continue;
    if (matchAny(exclude, rel)) continue;
    out.push(rel);
  }
}

/** True when no file anywhere under `relDir` could survive the exclude list. */
function isDirExcluded(relDir: string, exclude: string[]): boolean {
  if (exclude.length === 0) return false;
  return matchAny(exclude, relDir) || matchAny(exclude, `${relDir}/${PROBE}`);
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

async function readDocInternal(
  root: string,
  relPath: string,
): Promise<{ record: DocRecord; skipped: boolean }> {
  const rel = toPosix(relPath);
  const abs = join(root, rel);

  let size = 0;
  try {
    const info = await stat(abs);
    if (!info.isFile()) return { record: emptyRecord(rel), skipped: true };
    size = info.size;
  } catch {
    return { record: emptyRecord(rel), skipped: true };
  }

  if (size > MAX_FILE_BYTES) return { record: emptyRecord(rel), skipped: true };

  let buffer: Buffer;
  try {
    buffer = await readFile(abs);
  } catch {
    return { record: emptyRecord(rel), skipped: true };
  }

  // A NUL byte in the first block means binary. Markdown never contains one,
  // and decoding a binary file as UTF-8 produces garbage headings and hashes.
  if (buffer.subarray(0, 8192).includes(0)) {
    return { record: emptyRecord(rel), skipped: true };
  }

  const raw = buffer.toString('utf8');
  const parsed = parseFrontmatter(raw);
  // Validation is what turns a loose record into typed frontmatter; the
  // errors themselves belong to `kontext check`, which re-validates to report
  // them. Here we keep only the values that survived.
  const { value } = validateFrontmatter(parsed.data);

  const body = parsed.body;
  const headings = extractHeadings(body);

  return {
    record: {
      path: rel,
      frontmatter: value,
      hasFrontmatter: parsed.hasFrontmatter,
      title: headings.title ?? prettifyFilename(rel),
      headings: headings.all,
      body,
      wordCount: countWords(body),
      tokenEstimate: estimateTokens(body),
      contentHash: hashBody(body),
    },
    skipped: false,
  };
}

function emptyRecord(relPath: string): DocRecord {
  return {
    path: relPath,
    frontmatter: {},
    hasFrontmatter: false,
    title: prettifyFilename(relPath),
    headings: [],
    body: '',
    wordCount: 0,
    tokenEstimate: 0,
    contentHash: hashBody(''),
  };
}

/**
 * Collect ATX headings, tracking fenced code so that shell comments and
 * Python `# TODO` lines are not mistaken for structure. The first level-1
 * heading becomes the title; if a doc has none, the first heading of any level
 * is used before falling back to the filename — plenty of docs start at `##`.
 *
 * Setext headings (`Title\n=====`) are not recognised; they are rare in
 * tool-authored markdown and the filename fallback covers them.
 */
function extractHeadings(body: string): { title: string | null; all: string[] } {
  const all: string[] = [];
  let title: string | null = null;
  let firstAny: string | null = null;
  let inFence = false;

  for (const line of body.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = HEADING_RE.exec(line);
    if (!match) continue;

    const level = match[1]!.length;
    // Strip optional closing hashes: `## Title ##`.
    const text = match[2]!.replace(/\s+#+\s*$/, '').trim();
    if (text.length === 0) continue;

    all.push(text);
    if (firstAny === null) firstAny = text;
    if (level === 1 && title === null) title = text;
  }

  return { title: title ?? firstAny, all };
}

/**
 * `docs/api-reference.md` -> `Api Reference`; `README.md` -> `README`.
 * Tokens that are already all-caps are left alone so acronyms survive.
 */
function prettifyFilename(relPath: string): string {
  const name = basename(relPath, extname(relPath));
  const words = name.split(/[-_.\s]+/).filter((word) => word.length > 0);
  if (words.length === 0) return name;
  return words
    .map((word) =>
      word === word.toUpperCase() ? word : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

function countWords(body: string): number {
  const trimmed = body.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Hash the body with whitespace collapsed, so a doc that was only reflowed or
 * re-indented hashes identically to its original. Duplicate detection is about
 * meaning, and a prettier pass is not a meaning change.
 */
function hashBody(body: string): string {
  const normalized = body.replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function toPosix(relPath: string): string {
  let p = relPath.split(sep).join('/').replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

/**
 * Convenience for callers holding an absolute path (a CLI argument, an editor
 * selection) that need the repo-relative POSIX form `readDoc` expects.
 */
export function toRepoRelative(root: string, absPath: string): string {
  return toPosix(relative(root, absPath));
}
