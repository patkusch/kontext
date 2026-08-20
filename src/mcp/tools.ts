/**
 * Tool definitions and handlers for the kontext MCP server.
 *
 * Every tool here answers one question an agent has before it trusts a document:
 * "what should I read for this task", "has this doc rotted", "do my sources
 * disagree". The descriptions are written for an LLM choosing between tools —
 * they are part of the product, not documentation.
 *
 * Two rules hold across every handler:
 *   1. Nothing is ever omitted silently. Withheld material is named, with cause.
 *   2. No handler throws. Failures come back as structured, actionable content.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';

import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  FRESHNESS_SEVERITY,
  KONTEXT_SPEC_VERSION,
  type DocKind,
  type DocRecord,
  type Freshness,
  type FreshnessReport,
} from '../types.js';
import { readDoc } from '../core/scan.js';
import { buildPack, scoreRelevance } from '../core/rank.js';
import { findConflicts } from '../core/conflicts.js';
import { estimateTokens } from '../util/tokens.js';
import { getState, gitQuery, type KontextState } from './cache.js';

/* ------------------------------------------------------------------ */
/* Shared shapes                                                       */
/* ------------------------------------------------------------------ */

export interface ToolContext {
  /** Absolute path to the resolved repo root. */
  root: string;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  annotations?: Tool['annotations'];
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<CallToolResult>;
}

const DOC_KINDS: readonly DocKind[] = [
  'guide',
  'decision',
  'runbook',
  'reference',
  'handoff',
  'index',
  'spec',
];

const FRESHNESS_VALUES: readonly Freshness[] = [
  'fresh',
  'drifting',
  'stale',
  'expired',
  'superseded',
  'orphaned',
  'unverified',
];

const HANDOFF_REL_PATH = '.kontext/handoff.md';
const HANDOFF_TTL_DAYS = 7;

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function fail(title: string, detail: string[]): CallToolResult {
  const body = [`ERROR: ${title}`, ...detail.map((d) => d)].join('\n');
  return { content: [{ type: 'text', text: body }], isError: true };
}

class ToolInputError extends Error {}

/* ------------------------------------------------------------------ */
/* Argument validation (the low-level Server does not validate for us)  */
/* ------------------------------------------------------------------ */

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolInputError(`\`${key}\` is required and must be a non-empty string.`);
  }
  return value.trim();
}

function optString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ToolInputError(`\`${key}\` must be a string if provided.`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function optNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ToolInputError(`\`${key}\` must be a finite number if provided.`);
  }
  return value;
}

function optBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new ToolInputError(`\`${key}\` must be a boolean if provided.`);
  }
  return value;
}

function optStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ToolInputError(`\`${key}\` must be an array of strings if provided.`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new ToolInputError(`\`${key}\` must contain only strings.`);
    }
    const trimmed = item.trim();
    if (trimmed !== '') out.push(trimmed);
  }
  return out;
}

function optEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = optString(args, key);
  if (value === undefined) return undefined;
  const match = allowed.find((a) => a === value);
  if (match === undefined) {
    throw new ToolInputError(`\`${key}\` must be one of: ${allowed.join(', ')}. Got "${value}".`);
  }
  return match;
}

function optEnumArray<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T[] | undefined {
  const values = optStringArray(args, key);
  if (values === undefined || values.length === 0) return undefined;
  const out: T[] = [];
  for (const value of values) {
    const match = allowed.find((a) => a === value);
    if (match === undefined) {
      throw new ToolInputError(`\`${key}\` may only contain: ${allowed.join(', ')}. Got "${value}".`);
    }
    out.push(match);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Path safety                                                         */
/* ------------------------------------------------------------------ */

type SafePath = { ok: true; abs: string; rel: string } | { ok: false; reason: string };

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Resolve the deepest existing ancestor of `target` through symlinks, then
 * re-append the not-yet-created segments. Lets containment be proven for paths
 * that do not exist on disk yet (e.g. .kontext/handoff.md before first write).
 */
function realpathNearestExisting(target: string): string {
  let current = target;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve a caller-supplied path against the repo root and prove containment.
 *
 * Rejects traversal (`../`), absolute paths pointing outside the root, NUL
 * bytes, and symlinks whose real target escapes the root.
 */
function safeResolve(root: string, input: string): SafePath {
  if (input.includes('\0')) {
    return { ok: false, reason: 'Path contains a NUL byte.' };
  }
  const abs = path.resolve(root, input);
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return {
      ok: false,
      reason: `Path escapes the repo root. kontext only serves files under ${root}.`,
    };
  }

  // Symlink containment: compare real paths, resolving as much of the path as
  // exists (a handoff target may not have been created yet).
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { ok: false, reason: `Repo root ${root} could not be resolved on disk.` };
  }
  const realTarget = realpathNearestExisting(abs);
  const realRel = path.relative(realRoot, realTarget);
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
    return {
      ok: false,
      reason: 'Path resolves through a symlink that points outside the repo root.',
    };
  }

  return { ok: true, abs, rel: toPosix(rel) };
}

/* ------------------------------------------------------------------ */
/* Minimal glob matching (no dependencies allowed)                      */
/* ------------------------------------------------------------------ */

function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === undefined) continue;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`${out}$`);
}

function matchesGlob(glob: string, relPath: string): boolean {
  const pattern = glob.replace(/^\.\//, '');
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return relPath === pattern || relPath.startsWith(`${pattern}/`);
  }
  return globToRegExp(pattern).test(relPath);
}

/* ------------------------------------------------------------------ */
/* Freshness formatting                                                */
/* ------------------------------------------------------------------ */

const FRESHNESS_LABEL: Record<Freshness, string> = {
  fresh: 'FRESH',
  drifting: 'DRIFTING',
  stale: 'STALE',
  expired: 'EXPIRED',
  superseded: 'SUPERSEDED',
  orphaned: 'ORPHANED',
  unverified: 'UNVERIFIED',
};

const FRESHNESS_MEANING: Record<Freshness, string> = {
  fresh: 'code it describes has not moved since the doc was last updated — safe to act on',
  drifting: 'described code moved recently but only slightly — verify specifics before acting',
  stale: 'described code moved materially after the doc was last updated — do not trust details',
  expired: 'past its declared expiry or TTL — treat as historical',
  superseded: 'another doc explicitly replaces this one — read the replacement instead',
  orphaned: 'its `describes` globs match no files — the subject was moved or deleted',
  unverified: 'no `describes` claim, so staleness cannot be proven either way',
};

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function shortDate(iso: string): string {
  return iso.slice(0, 10);
}

/** One dense line of git evidence behind a verdict. */
function evidenceLine(report: FreshnessReport): string {
  const drift = report.drift;
  if (drift === undefined) {
    return 'evidence: none — no `describes` claim to check against git history';
  }
  const parts: string[] = [];
  if (drift.docLastCommit !== null) {
    parts.push(`doc last touched ${shortSha(drift.docLastCommit.sha)} on ${shortDate(drift.docLastCommit.date)}`);
  } else {
    parts.push('doc has no commit history (uncommitted?)');
  }
  if (drift.codeLastCommit !== null) {
    parts.push(
      `described code last moved ${shortSha(drift.codeLastCommit.sha)} on ${shortDate(drift.codeLastCommit.date)}`,
    );
  } else {
    parts.push('described code has no commit history');
  }
  parts.push(`drift ${drift.driftDays}d across ${drift.commitsSince} commit(s)`);
  parts.push(`${drift.matchedFileCount} file(s) matched`);
  if (drift.missingGlobs.length > 0) {
    parts.push(`globs matching nothing: ${drift.missingGlobs.join(', ')}`);
  }
  return `evidence: ${parts.join('; ')}`;
}

/** Multi-line detail block for a single doc's verdict. */
function verdictBlock(report: FreshnessReport, opts: { heading?: boolean } = {}): string {
  const lines: string[] = [];
  const { doc } = report;
  if (opts.heading !== false) {
    lines.push(`## ${doc.title}`);
  }
  lines.push(
    `\`${doc.path}\` — **${FRESHNESS_LABEL[report.freshness]}** (trust score ${report.score}/100)`,
  );
  lines.push(`_${FRESHNESS_MEANING[report.freshness]}_`);
  const kind = doc.frontmatter.kind;
  const meta: string[] = [`kind: ${kind ?? 'unspecified'}`, `~${doc.tokenEstimate} tokens`];
  if (doc.frontmatter.id !== undefined) meta.unshift(`id: ${doc.frontmatter.id}`);
  if (doc.frontmatter.owner !== undefined) meta.push(`owner: ${doc.frontmatter.owner}`);
  if (doc.frontmatter.describes !== undefined && doc.frontmatter.describes.length > 0) {
    meta.push(`describes: ${doc.frontmatter.describes.join(', ')}`);
  }
  lines.push(meta.join(' | '));
  lines.push(evidenceLine(report));
  for (const reason of report.reasons) {
    lines.push(`- ${reason}`);
  }
  if (report.supersededBy !== undefined && report.supersededBy.length > 0) {
    lines.push(`- superseded by: ${report.supersededBy.join(', ')}`);
  }
  const drift = report.drift;
  if (drift !== undefined && drift.changedFiles.length > 0) {
    lines.push(`- moved since the doc: ${drift.changedFiles.slice(0, 8).join(', ')}`);
  }
  const verify = report.verify;
  if (verify !== undefined) {
    lines.push(
      `- verify command \`${verify.command}\` ${verify.passed ? 'PASSED' : `FAILED (exit ${verify.exitCode})`}`,
    );
  }
  return lines.join('\n');
}

function countByFreshness(reports: FreshnessReport[]): Map<Freshness, number> {
  const counts = new Map<Freshness, number>();
  for (const report of reports) {
    counts.set(report.freshness, (counts.get(report.freshness) ?? 0) + 1);
  }
  return counts;
}

function summaryLine(reports: FreshnessReport[]): string {
  const counts = countByFreshness(reports);
  const parts: string[] = [];
  for (const value of FRESHNESS_VALUES) {
    const n = counts.get(value);
    if (n !== undefined && n > 0) parts.push(`${FRESHNESS_LABEL[value]} ${n}`);
  }
  return parts.length > 0 ? parts.join(' | ') : 'no documents found';
}

function worstFirst(a: FreshnessReport, b: FreshnessReport): number {
  const severity = FRESHNESS_SEVERITY[b.freshness] - FRESHNESS_SEVERITY[a.freshness];
  if (severity !== 0) return severity;
  return a.score - b.score;
}

function corpusHeader(state: KontextState): string {
  const head = gitQuery(state.root, ['rev-parse', '--short', 'HEAD']) ?? 'no commits yet';
  return [
    `Root: ${state.root} | git HEAD: ${head}`,
    `Corpus: ${state.docs.length} doc(s) — ${summaryLine(state.reports)}`,
    `Assessment: ${state.rebuilt ? `rebuilt in ${state.buildMs}ms` : `cached ${Math.round((Date.now() - state.builtAt) / 1000)}s ago`}`,
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Snippets                                                            */
/* ------------------------------------------------------------------ */

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function snippetFor(doc: DocRecord, query: string, width = 220): string {
  const body = doc.body;
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((t) => t.length > 2);
  const haystack = body.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const idx = haystack.indexOf(term);
    if (idx >= 0 && (at < 0 || idx < at)) at = idx;
  }
  if (at < 0) {
    return `${collapse(body.slice(0, width))}${body.length > width ? '…' : ''}`;
  }
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(body.length, start + width);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < body.length ? '…' : '';
  return `${prefix}${collapse(body.slice(start, end))}${suffix}`;
}

/* ------------------------------------------------------------------ */
/* State access with actionable failures                                */
/* ------------------------------------------------------------------ */

function describeFailure(err: unknown): string[] {
  const message = err instanceof Error ? err.message : String(err);
  const lines = [message];
  const lower = message.toLowerCase();
  if (lower.includes('not a git repository') || lower.includes('no git') || lower.includes('repo root')) {
    lines.push(
      'kontext proves staleness from git history, so it needs a git repository.',
      'Fix: run the server from inside a repo, or set KONTEXT_ROOT to one (`git init` if this project is not versioned yet).',
    );
  } else if (lower.includes('cannot find module') || lower.includes('err_module_not_found')) {
    lines.push('The kontext build looks incomplete. Fix: run `npm run build` in the kontext checkout.');
  } else if (lower.includes('enoent')) {
    lines.push('A file or directory kontext expected was not found. Check the path and the resolved root.');
  }
  return lines;
}

async function loadState(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<{ ok: true; state: KontextState } | { ok: false; result: CallToolResult }> {
  const force = optBoolean(args, 'force') ?? false;
  try {
    const state = await getState(ctx.root, { force });
    return { ok: true, state };
  } catch (err) {
    return {
      ok: false,
      result: fail(`kontext could not read this repository (root: ${ctx.root})`, describeFailure(err)),
    };
  }
}

function findReport(state: KontextState, relPath: string): FreshnessReport | undefined {
  return state.reports.find((r) => r.doc.path === relPath);
}

/* ------------------------------------------------------------------ */
/* kontext_pack                                                        */
/* ------------------------------------------------------------------ */

const packTool: ToolDefinition = {
  name: 'kontext_pack',
  title: 'Pack fresh context for a task',
  description: [
    'THE tool to call before starting any non-trivial task in this repo. Give it the task you are about to do',
    'in plain language and it returns one ranked, token-budgeted markdown bundle of the project docs that',
    'actually bear on that task — instead of you reading every markdown file and burning the window on docs',
    'that rotted months ago.',
    '',
    'Ranking is relevance multiplied by *freshness*, where freshness is proven from git: a doc declares which',
    'source files it describes, and git shows whether that code moved after the doc was last updated. Fresh,',
    'high-signal docs come first; drifting ones are demoted and labelled; provably stale ones are withheld',
    'and then listed by name at the end with the reason, so you always know what was held back and can ask',
    'again with includeStale=true. Every section carries its path, verdict, trust score and commit evidence.',
    '',
    'Use it at the start of a task, after switching branches, or whenever you are unsure which docs are',
    'still true. Use kontext_search first if you only want to see what exists without spending tokens.',
  ].join('\n'),
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description:
          'The task you are about to perform, in plain language. Be specific — this string drives relevance ranking. e.g. "add rate limiting to the billing webhook handler".',
      },
      budget: {
        type: 'number',
        description:
          'Token ceiling for the whole bundle. Defaults to the repo config value (defaultPackBudget). Docs that do not fit are named in an "did not fit" list rather than dropped silently.',
      },
      includeStale: {
        type: 'boolean',
        description:
          'Include docs whose described code has provably moved since they were last updated. Default false. Set true when you deliberately want historical or last-resort context, and treat what comes back with suspicion.',
      },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: [...DOC_KINDS] },
        description:
          'Restrict to these document kinds: guide, decision (ADRs), runbook, reference, handoff, index, spec. Omit for all kinds.',
      },
      force: {
        type: 'boolean',
        description: 'Bypass the ~30s scan cache and re-assess the repo from git. Use after you have just committed or edited docs.',
      },
    },
    required: ['task'],
  },
  handler: async (args, ctx) => {
    const task = requireString(args, 'task');
    const budgetArg = optNumber(args, 'budget');
    const includeStale = optBoolean(args, 'includeStale');
    const kinds = optEnumArray(args, 'kinds', DOC_KINDS);

    const loaded = await loadState(ctx, args);
    if (!loaded.ok) return loaded.result;
    const { state } = loaded;

    if (state.reports.length === 0) {
      return ok(
        [
          '# kontext pack — nothing to pack',
          corpusHeader(state),
          '',
          'No markdown documents matched this repo\'s kontext config (include/exclude globs).',
          'Nothing is being hidden from you: the corpus is genuinely empty. Proceed from the code itself.',
        ].join('\n'),
      );
    }

    const budget = budgetArg ?? state.config.defaultPackBudget;
    if (budget <= 0) {
      throw new ToolInputError('`budget` must be greater than 0.');
    }

    const packOpts: { budget: number; includeStale?: boolean; kinds?: DocKind[] } = { budget };
    if (includeStale !== undefined) packOpts.includeStale = includeStale;
    if (kinds !== undefined) packOpts.kinds = kinds;

    const pack = buildPack(task, state.reports, packOpts);

    const pct = pack.budget > 0 ? Math.round((pack.tokensUsed / pack.budget) * 100) : 0;
    const lines: string[] = [];
    lines.push('# kontext pack');
    lines.push('');
    lines.push(`**Task:** ${pack.task}`);
    lines.push(`**Generated:** ${pack.generatedAt}`);
    lines.push(corpusHeader(state));
    lines.push(
      `**Budget:** ${pack.budget} tokens — used ${pack.tokensUsed} (${pct}%) | included ${pack.entries.length} | did not fit ${pack.omitted.length} | withheld as stale ${pack.excludedForStaleness.length}`,
    );
    if (kinds !== undefined) lines.push(`**Kinds filter:** ${kinds.join(', ')}`);
    lines.push(`**Stale docs included:** ${includeStale === true ? 'yes (treat with suspicion)' : 'no'}`);
    lines.push('');
    lines.push(
      '> Provenance: every section below is a real file in this repo, ranked by relevance to the task and',
      '> weighted by a freshness verdict proven from git history. Trust the verdicts more than the prose.',
    );

    if (pack.entries.length === 0) {
      lines.push('');
      lines.push('## No documents were included');
      lines.push(
        'Nothing scored high enough, or everything relevant was filtered out. See the withheld list below before concluding this repo has no context.',
      );
    }

    pack.entries.forEach((entry, index) => {
      const report = findReport(state, entry.path);
      lines.push('');
      lines.push('---');
      lines.push('');
      lines.push(`## [${index + 1}] ${entry.title}`);
      lines.push(
        `\`${entry.path}\` — **${FRESHNESS_LABEL[entry.freshness]}** | relevance ${entry.relevance.toFixed(2)} | rank ${entry.rank.toFixed(2)} | ~${entry.tokens} tokens${entry.truncated ? ' | TRUNCATED to fit the budget' : ''}`,
      );
      lines.push(`_${FRESHNESS_MEANING[entry.freshness]}_`);
      if (report !== undefined) {
        lines.push(evidenceLine(report));
        if (report.reasons.length > 0) {
          lines.push(`why: ${report.reasons.join(' · ')}`);
        }
      }
      if (entry.truncated) {
        lines.push('NOTE: this document was cut to fit the budget — call kontext_read on its path for the full text.');
      }
      lines.push('');
      lines.push(entry.content);
    });

    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(`## Did not fit the budget (${pack.omitted.length})`);
    if (pack.omitted.length === 0) {
      lines.push('None — everything that ranked was included.');
    } else {
      lines.push('These were relevant but exceeded the token budget. Raise `budget` or read them directly:');
      for (const item of pack.omitted) {
        lines.push(`- \`${item.path}\` — ${item.title} — ${item.reason}`);
      }
    }

    lines.push('');
    lines.push(`## Withheld for staleness (${pack.excludedForStaleness.length})`);
    if (pack.excludedForStaleness.length === 0) {
      lines.push('None — no document was held back for being out of date.');
    } else {
      lines.push(
        'These matched your task but git shows the code they describe has moved since they were last updated.',
        'They are named here so the omission is never invisible. Re-run with includeStale=true to see them anyway,',
        'or call kontext_freshness on a path for the full commit evidence.',
      );
      for (const item of pack.excludedForStaleness) {
        lines.push(`- \`${item.path}\` — ${FRESHNESS_LABEL[item.freshness]} (${FRESHNESS_MEANING[item.freshness]})`);
      }
    }

    return ok(lines.join('\n'));
  },
};

/* ------------------------------------------------------------------ */
/* kontext_freshness                                                   */
/* ------------------------------------------------------------------ */

const freshnessTool: ToolDefinition = {
  name: 'kontext_freshness',
  title: 'Can I trust this doc?',
  description: [
    'Ask whether a document is still true before you act on it. Returns the freshness verdict — fresh,',
    'drifting, stale, expired, superseded, orphaned or unverified — with the git evidence behind it: which',
    'commit last touched the doc, which commit last touched the code it claims to describe, how many days and',
    'commits of drift sit between them, and which files moved.',
    '',
    'Call with `path` for one document, `glob` for a subset (e.g. "docs/**/*.md"), or no argument at all for a',
    'whole-repo health table sorted worst-first. Use this when a doc is about to inform a decision, when a pack',
    'section looked suspicious, or when you want to know what documentation debt a change has created.',
  ].join('\n'),
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Repo-relative path to one document, e.g. "docs/architecture.md". Mutually exclusive with `glob`.',
      },
      glob: {
        type: 'string',
        description: 'Glob over repo-relative paths, e.g. "docs/**/*.md" or "**/runbooks/*.md". Supports *, ** and ?.',
      },
      force: {
        type: 'boolean',
        description: 'Bypass the ~30s scan cache and re-assess from git.',
      },
    },
  },
  handler: async (args, ctx) => {
    const target = optString(args, 'path');
    const glob = optString(args, 'glob');
    if (target !== undefined && glob !== undefined) {
      throw new ToolInputError('Pass `path` or `glob`, not both.');
    }

    const loaded = await loadState(ctx, args);
    if (!loaded.ok) return loaded.result;
    const { state } = loaded;

    if (target !== undefined) {
      const safe = safeResolve(ctx.root, target);
      if (!safe.ok) return fail(`Refusing to inspect "${target}"`, [safe.reason]);
      const report = findReport(state, safe.rel);
      if (report === undefined) {
        return fail(`No kontext record for \`${safe.rel}\``, [
          'That path is not part of this repo\'s managed corpus — it may not exist, may not be markdown, or may be excluded by config.',
          `Known documents: ${state.docs.length}. Call kontext_freshness with no arguments to list them, or kontext_read to read the file anyway.`,
        ]);
      }
      return ok(
        [
          '# kontext freshness',
          corpusHeader(state),
          '',
          verdictBlock(report),
          '',
          report.freshness === 'fresh'
            ? 'Verdict: safe to act on.'
            : 'Verdict: verify against the code before acting on specifics in this document.',
        ].join('\n'),
      );
    }

    const selected =
      glob === undefined ? state.reports : state.reports.filter((r) => matchesGlob(glob, r.doc.path));

    if (selected.length === 0) {
      return ok(
        [
          '# kontext freshness',
          corpusHeader(state),
          '',
          glob === undefined
            ? 'No managed documents in this repo.'
            : `No managed documents matched glob \`${glob}\`.`,
        ].join('\n'),
      );
    }

    const sorted = [...selected].sort(worstFirst);
    const lines: string[] = [];
    lines.push('# kontext freshness');
    lines.push(corpusHeader(state));
    if (glob !== undefined) lines.push(`Filter: \`${glob}\` matched ${sorted.length} doc(s)`);
    lines.push('');
    lines.push(`Selection: ${summaryLine(sorted)}`);
    lines.push('');
    lines.push('| verdict | score | path | drift | why |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const report of sorted) {
      const drift = report.drift;
      const driftCell =
        drift === undefined ? '—' : `${drift.driftDays}d / ${drift.commitsSince} commits`;
      const why = report.reasons.length > 0 ? report.reasons.join('; ') : FRESHNESS_MEANING[report.freshness];
      lines.push(
        `| ${FRESHNESS_LABEL[report.freshness]} | ${report.score} | \`${report.doc.path}\` | ${driftCell} | ${why.replace(/\|/g, '/')} |`,
      );
    }

    const problems = sorted.filter((r) => r.freshness !== 'fresh' && r.freshness !== 'unverified');
    if (problems.length > 0) {
      lines.push('');
      lines.push(`## Evidence for the ${Math.min(problems.length, 10)} worst`);
      for (const report of problems.slice(0, 10)) {
        lines.push('');
        lines.push(verdictBlock(report));
      }
    }

    return ok(lines.join('\n'));
  },
};

/* ------------------------------------------------------------------ */
/* kontext_search                                                      */
/* ------------------------------------------------------------------ */

const searchTool: ToolDefinition = {
  name: 'kontext_search',
  title: 'Find docs without spending the window',
  description: [
    'Cheap discovery: rank the repo\'s context docs against a query and get back title, path, freshness verdict,',
    'relevance score and a short snippet for each — without pulling whole documents into your context window.',
    '',
    'Use it to find out what exists, to pick which single doc to kontext_read, or to check whether the project',
    'has anything at all on a subject before you assume and guess. Results carry the same git-proven freshness',
    'verdicts as everywhere else, and `minFreshness` lets you filter out material you already know you cannot',
    'trust. When you actually want the content assembled for a task, call kontext_pack instead.',
  ].join('\n'),
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Words or phrase to rank documents against, e.g. "webhook retry policy".',
      },
      limit: {
        type: 'number',
        description: 'Maximum results to return. Default 10.',
      },
      minFreshness: {
        type: 'string',
        enum: [...FRESHNESS_VALUES],
        description:
          'Worst verdict you are willing to see, on the severity ladder fresh < unverified < drifting < stale < expired < orphaned < superseded. e.g. "drifting" returns fresh, unverified and drifting docs only. Filtered-out matches are still counted and named so nothing disappears silently.',
      },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: [...DOC_KINDS] },
        description: 'Restrict to these document kinds.',
      },
      force: {
        type: 'boolean',
        description: 'Bypass the ~30s scan cache and re-assess from git.',
      },
    },
    required: ['query'],
  },
  handler: async (args, ctx) => {
    const query = requireString(args, 'query');
    const limit = Math.max(1, Math.min(50, Math.round(optNumber(args, 'limit') ?? 10)));
    const minFreshness = optEnum(args, 'minFreshness', FRESHNESS_VALUES);
    const kinds = optEnumArray(args, 'kinds', DOC_KINDS);

    const loaded = await loadState(ctx, args);
    if (!loaded.ok) return loaded.result;
    const { state } = loaded;

    const ceiling = minFreshness === undefined ? Number.MAX_SAFE_INTEGER : FRESHNESS_SEVERITY[minFreshness];

    const scored = state.reports
      .map((report) => ({ report, relevance: scoreRelevance(query, report.doc) }))
      .filter((row) => row.relevance > 0);

    const kindFiltered =
      kinds === undefined
        ? scored
        : scored.filter((row) => {
            const kind = row.report.doc.frontmatter.kind;
            return kind !== undefined && kinds.includes(kind);
          });

    const withheld = kindFiltered.filter((row) => FRESHNESS_SEVERITY[row.report.freshness] > ceiling);
    const kept = kindFiltered
      .filter((row) => FRESHNESS_SEVERITY[row.report.freshness] <= ceiling)
      .sort((a, b) => {
        const byRelevance = b.relevance - a.relevance;
        if (Math.abs(byRelevance) > 1e-6) return byRelevance;
        return b.report.score - a.report.score;
      });

    const lines: string[] = [];
    lines.push('# kontext search');
    lines.push(corpusHeader(state));
    lines.push(`Query: "${query}" | matches ${kindFiltered.length} | showing ${Math.min(limit, kept.length)}`);
    if (minFreshness !== undefined) lines.push(`minFreshness: ${minFreshness}`);
    if (kinds !== undefined) lines.push(`kinds: ${kinds.join(', ')}`);
    lines.push('');

    if (kept.length === 0) {
      lines.push('No document matched this query.');
      lines.push(
        'That is a real answer: this repo has no written context on the subject. Read the code, and consider writing a doc (kontext_handoff_write is for working state, not durable docs).',
      );
    }

    kept.slice(0, limit).forEach((row, index) => {
      const { report } = row;
      const kind = report.doc.frontmatter.kind ?? 'unspecified';
      lines.push(
        `### ${index + 1}. ${report.doc.title} — **${FRESHNESS_LABEL[report.freshness]}**`,
      );
      lines.push(
        `\`${report.doc.path}\` | relevance ${row.relevance.toFixed(2)} | trust ${report.score}/100 | kind ${kind} | ~${report.doc.tokenEstimate} tokens`,
      );
      lines.push(evidenceLine(report));
      lines.push(`> ${snippetFor(report.doc, query)}`);
      lines.push('');
    });

    if (kept.length > limit) {
      lines.push(`(${kept.length - limit} further match(es) not shown — raise \`limit\` to see them.)`);
      lines.push('');
    }

    if (withheld.length > 0) {
      lines.push(`## Filtered out by minFreshness (${withheld.length})`);
      lines.push('These matched your query but fall below the trust floor you set:');
      for (const row of withheld.slice(0, 20)) {
        lines.push(`- \`${row.report.doc.path}\` — ${FRESHNESS_LABEL[row.report.freshness]}`);
      }
    }

    return ok(lines.join('\n'));
  },
};

/* ------------------------------------------------------------------ */
/* kontext_read                                                        */
/* ------------------------------------------------------------------ */

const readTool: ToolDefinition = {
  name: 'kontext_read',
  title: 'Read a doc with its trust verdict',
  description: [
    'Read one context document *with its freshness verdict attached*. Prefer this over a plain file read for any',
    'markdown in this repo: the point of kontext is that you never see a document without being told whether it',
    'can still be trusted. The header carries the verdict, the trust score, and the commit evidence — which',
    'commit last touched the doc, which commit last touched the code it describes — before a single line of',
    'the body.',
    '',
    'Paths are repo-relative and confined to the repo root; traversal and symlink escapes are refused. If the',
    'file is outside the managed corpus you still get its contents, clearly labelled as unverified.',
  ].join('\n'),
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Repo-relative path to the document, e.g. "docs/architecture.md".',
      },
    },
    required: ['path'],
  },
  handler: async (args, ctx) => {
    const requested = requireString(args, 'path');
    const safe = safeResolve(ctx.root, requested);
    if (!safe.ok) {
      return fail(`Refusing to read "${requested}"`, [
        safe.reason,
        'Pass a repo-relative path such as "docs/architecture.md".',
      ]);
    }

    const loaded = await loadState(ctx, args);
    if (!loaded.ok) return loaded.result;
    const { state } = loaded;

    const report = findReport(state, safe.rel);
    if (report !== undefined) {
      return ok(
        [
          `# ${report.doc.title}`,
          '',
          verdictBlock(report, { heading: false }),
          '',
          '---',
          '',
          report.doc.body,
        ].join('\n'),
      );
    }

    // Outside the managed corpus — still serve it, but say so loudly.
    let doc: DocRecord;
    try {
      doc = await readDoc(ctx.root, safe.rel);
    } catch (err) {
      return fail(`Could not read \`${safe.rel}\``, describeFailure(err));
    }

    return ok(
      [
        `# ${doc.title}`,
        '',
        `\`${doc.path}\` — **UNVERIFIED (not tracked by kontext)**`,
        '_This file is outside the managed corpus (excluded by config, or not markdown), so no staleness claim can be made about it either way. Nothing here is proven current._',
        `~${doc.tokenEstimate} tokens | ${doc.wordCount} words | frontmatter: ${doc.hasFrontmatter ? 'present' : 'none'}`,
        doc.hasFrontmatter
          ? ''
          : 'Tip: adding kontext frontmatter with a `describes` glob would let git prove whether this doc is still true.',
        '',
        '---',
        '',
        doc.body,
      ].join('\n'),
    );
  },
};

/* ------------------------------------------------------------------ */
/* Handoffs                                                            */
/* ------------------------------------------------------------------ */

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}

function gitSnapshot(root: string): { branch: string; head: string; changed: string[] } {
  const branch = gitQuery(root, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'unknown';
  const head = gitQuery(root, ['log', '-1', '--pretty=%h %s']) ?? 'no commits yet';
  const status = gitQuery(root, ['status', '--porcelain']);
  const changed: string[] = [];
  if (status !== null && status !== '') {
    for (const line of status.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const parts = trimmed.split(/\s+/);
      const file = parts[parts.length - 1];
      if (file !== undefined) changed.push(file);
    }
  }
  return { branch, head, changed };
}

const handoffWriteTool: ToolDefinition = {
  name: 'kontext_handoff_write',
  title: 'Hand your working state to the next agent',
  description: [
    'Write the working state of this session to `.kontext/handoff.md` so the next agent (or the next you, in a',
    'fresh window) can resume without the conversation that produced it. Captures the task, what you learned,',
    'the open questions, and the concrete next steps, plus the branch, HEAD commit and working-tree changes at',
    'the moment of writing.',
    '',
    'The file is written with `kind: handoff` and `ttlDays: 7`, because working state rots faster than anything',
    'else in a repo — a week-old handoff describing a branch that has since merged is actively misleading, and',
    'kontext will mark it expired rather than let it lie. Call this before you run out of context, before a',
    'branch switch, or whenever you are about to hand off. Writing again replaces the previous handoff.',
    '',
    'Write it so a stranger could resume from it alone: if it only makes sense to someone who saw this',
    'conversation, it is a note, not a handoff.',
  ].join('\n'),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'What this session was trying to accomplish, in one line.',
      },
      summary: {
        type: 'string',
        description:
          'What actually happened: what was done, what was learned, what was ruled out and why. Markdown is fine. Assume the reader saw none of it.',
      },
      openQuestions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Unresolved questions or decisions the next agent must settle.',
      },
      nextSteps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Concrete next actions, in order, specific enough to start on immediately.',
      },
    },
    required: ['task', 'summary'],
  },
  handler: async (args, ctx) => {
    const task = requireString(args, 'task');
    const summary = requireString(args, 'summary');
    const openQuestions = optStringArray(args, 'openQuestions') ?? [];
    const nextSteps = optStringArray(args, 'nextSteps') ?? [];

    const safe = safeResolve(ctx.root, HANDOFF_REL_PATH);
    if (!safe.ok) return fail('Could not resolve the handoff path', [safe.reason]);

    const now = new Date();
    const snapshot = gitSnapshot(ctx.root);
    const describes = snapshot.changed.filter((f) => f !== HANDOFF_REL_PATH).slice(0, 20);

    const frontmatter: string[] = [
      '---',
      `kontext: ${KONTEXT_SPEC_VERSION}`,
      'id: handoff',
      'kind: handoff',
      `ttlDays: ${HANDOFF_TTL_DAYS}`,
      `updated: ${now.toISOString()}`,
      `title: ${yamlString(`Handoff: ${task}`)}`,
    ];
    if (describes.length > 0) {
      frontmatter.push('describes:');
      for (const file of describes) frontmatter.push(`  - ${yamlString(file)}`);
    }
    frontmatter.push('tags:', '  - handoff', '---');

    const expiresAt = new Date(now.getTime() + HANDOFF_TTL_DAYS * 86_400_000);
    const body: string[] = [
      '',
      `# Handoff: ${task}`,
      '',
      `Written ${now.toISOString()} by an agent via the kontext MCP server.`,
      `Expires ${expiresAt.toISOString().slice(0, 10)} (ttlDays: ${HANDOFF_TTL_DAYS}) — after that, kontext reports this as EXPIRED.`,
      '',
      '## Repo state at handoff',
      '',
      `- branch: \`${snapshot.branch}\``,
      `- HEAD: ${snapshot.head}`,
      `- working tree: ${snapshot.changed.length === 0 ? 'clean' : `${snapshot.changed.length} changed file(s)`}`,
    ];
    for (const file of snapshot.changed.slice(0, 20)) body.push(`  - \`${file}\``);
    if (snapshot.changed.length > 20) body.push(`  - …and ${snapshot.changed.length - 20} more`);

    body.push('', '## What happened', '', summary, '');

    body.push('## Open questions', '');
    if (openQuestions.length === 0) body.push('- None recorded.');
    else for (const q of openQuestions) body.push(`- ${q}`);
    body.push('');

    body.push('## Next steps', '');
    if (nextSteps.length === 0) body.push('- None recorded.');
    else nextSteps.forEach((step, i) => body.push(`${i + 1}. ${step}`));
    body.push('');

    const content = `${frontmatter.join('\n')}${body.join('\n')}`;

    try {
      await mkdir(path.dirname(safe.abs), { recursive: true });
      await writeFile(safe.abs, content, 'utf8');
    } catch (err) {
      return fail('Could not write the handoff', describeFailure(err));
    }

    return ok(
      [
        `Handoff written to \`${HANDOFF_REL_PATH}\` (${estimateTokens(content)} tokens).`,
        `Expires ${expiresAt.toISOString().slice(0, 10)} — 7 days from now; after that kontext reports it EXPIRED rather than trusting it.`,
        `Branch \`${snapshot.branch}\`, ${snapshot.changed.length} changed file(s) recorded${describes.length > 0 ? ' and declared in `describes`, so this handoff goes stale if that code moves' : ''}.`,
        `Sections: ${openQuestions.length} open question(s), ${nextSteps.length} next step(s).`,
        'The next agent should call kontext_handoff_read to pick this up.',
      ].join('\n'),
    );
  },
};

const handoffReadTool: ToolDefinition = {
  name: 'kontext_handoff_read',
  title: 'Pick up the last session\'s working state',
  description: [
    'Read `.kontext/handoff.md` — the working state left behind by the previous session or agent — together',
    'with its age and an explicit expiry warning. Call it at the start of a session, before assuming you are',
    'starting from scratch, or whenever the user refers to work "we" already did.',
    '',
    'Handoffs expire after 7 days by design. An expired handoff is worse than none, because it describes a',
    'branch and a working tree that have probably moved on, so this tool shouts about it rather than handing',
    'you rotten state quietly. If no handoff exists, that is reported plainly and is not an error.',
  ].join('\n'),
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => {
    const safe = safeResolve(ctx.root, HANDOFF_REL_PATH);
    if (!safe.ok) return fail('Could not resolve the handoff path', [safe.reason]);

    let raw: string;
    try {
      raw = await readFile(safe.abs, 'utf8');
    } catch {
      return ok(
        [
          '# No handoff found',
          '',
          `There is no \`${HANDOFF_REL_PATH}\` in ${ctx.root}.`,
          'No previous session left working state here. Start from kontext_pack for durable context,',
          'and call kontext_handoff_write before your own session ends.',
        ].join('\n'),
      );
    }

    // Age: prefer the `updated:` stamp written into the frontmatter, fall back to mtime.
    let written: Date | null = null;
    const stamp = /^updated:\s*(\S+)\s*$/m.exec(raw);
    const stampValue = stamp?.[1];
    if (stampValue !== undefined) {
      const parsed = new Date(stampValue);
      if (!Number.isNaN(parsed.getTime())) written = parsed;
    }
    if (written === null) {
      try {
        written = new Date((await stat(safe.abs)).mtimeMs);
      } catch {
        written = null;
      }
    }

    const ttlMatch = /^ttlDays:\s*(\d+)\s*$/m.exec(raw);
    const ttlRaw = ttlMatch?.[1];
    const ttlDays = ttlRaw === undefined ? HANDOFF_TTL_DAYS : Number.parseInt(ttlRaw, 10);

    const ageDays =
      written === null ? null : Math.floor((Date.now() - written.getTime()) / 86_400_000);
    const expired = ageDays !== null && ageDays > ttlDays;

    const header: string[] = ['# kontext handoff', ''];
    if (expired) {
      header.push(
        '## WARNING — THIS HANDOFF IS EXPIRED',
        '',
        `It was written ${ageDays} days ago and its TTL is ${ttlDays} days. Working state rots fast: the branch it`,
        'describes may be merged or gone, the working tree it lists almost certainly no longer exists, and its',
        '"next steps" may already be done. Treat everything below as a historical hint, verify against git before',
        'acting on any of it, and prefer kontext_pack for context that is actually current.',
        '',
      );
    } else if (ageDays !== null) {
      header.push(
        `Age: ${ageDays} day(s) old, TTL ${ttlDays} days — within its useful life, but verify anything that touches code before acting.`,
        '',
      );
    } else {
      header.push('Age: unknown (no `updated` stamp and no readable mtime) — treat with caution.', '');
    }

    // If the handoff is in the managed corpus, attach kontext's own verdict too.
    try {
      const state = await getState(ctx.root);
      const report = findReport(state, safe.rel);
      if (report !== undefined) {
        header.push(
          `kontext verdict: **${FRESHNESS_LABEL[report.freshness]}** (trust ${report.score}/100) — ${FRESHNESS_MEANING[report.freshness]}`,
          evidenceLine(report),
          '',
        );
      }
    } catch {
      // Degrade quietly — a handoff is still readable in a repo kontext cannot assess.
    }

    header.push('---', '', raw);
    return ok(header.join('\n'));
  },
};

/* ------------------------------------------------------------------ */
/* kontext_conflicts                                                   */
/* ------------------------------------------------------------------ */

/**
 * Render a conflict record without assuming its exact shape — the conflicts
 * module owns that type, and this layer should not go stale when it grows a
 * field. Known-interesting keys are surfaced first, then everything else.
 */
function renderConflict(value: unknown, index: number): string[] {
  const lines: string[] = [];
  if (value === null || typeof value !== 'object') {
    lines.push(`${index}. ${String(value)}`);
    return lines;
  }
  const record = value as Record<string, unknown>;
  const scalar = (key: string): string | undefined => {
    const v = record[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return undefined;
  };
  const list = (key: string): string[] | undefined => {
    const v = record[key];
    if (!Array.isArray(v)) return undefined;
    return v.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));
  };

  const kind = scalar('kind') ?? scalar('type') ?? 'conflict';
  const severity = scalar('severity');
  lines.push(`### ${index}. ${kind}${severity === undefined ? '' : ` (${severity})`}`);

  const paths =
    list('paths') ?? list('docs') ?? list('files') ?? list('members') ?? list('ids') ?? undefined;
  if (paths !== undefined && paths.length > 0) {
    lines.push(`involves: ${paths.map((p) => `\`${p}\``).join(', ')}`);
  } else {
    const a = scalar('a') ?? scalar('left') ?? scalar('docA');
    const b = scalar('b') ?? scalar('right') ?? scalar('docB');
    if (a !== undefined || b !== undefined) {
      lines.push(`involves: \`${a ?? '?'}\` vs \`${b ?? '?'}\``);
    }
  }

  const detail =
    scalar('detail') ?? scalar('message') ?? scalar('description') ?? scalar('reason') ?? scalar('summary');
  if (detail !== undefined) lines.push(detail);

  const shown = new Set([
    'kind',
    'type',
    'severity',
    'paths',
    'docs',
    'files',
    'members',
    'ids',
    'a',
    'b',
    'left',
    'right',
    'docA',
    'docB',
    'detail',
    'message',
    'description',
    'reason',
    'summary',
  ]);
  for (const [key, raw] of Object.entries(record)) {
    if (shown.has(key)) continue;
    if (raw === null || raw === undefined) continue;
    if (typeof raw === 'object' && !Array.isArray(raw)) continue;
    const rendered = Array.isArray(raw)
      ? raw.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(', ')
      : String(raw);
    if (rendered.trim() === '') continue;
    lines.push(`- ${key}: ${rendered}`);
  }
  return lines;
}

const conflictsTool: ToolDefinition = {
  name: 'kontext_conflicts',
  title: 'Do my sources disagree?',
  description: [
    'Detect contradictions and duplicates across the repo\'s context docs: near-identical documents, competing',
    'claims about the same subject, superseded docs that are still lying around, several docs describing the',
    'same source files with different verdicts.',
    '',
    'Call it before you rely on two documents at once, when a pack returned material that seemed to disagree',
    'with itself, or when auditing documentation health. Freshness tells you whether one doc is true;',
    'conflicts tell you which of two to believe.',
  ].join('\n'),
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      force: {
        type: 'boolean',
        description: 'Bypass the ~30s scan cache and re-scan the repo first.',
      },
    },
  },
  handler: async (args, ctx) => {
    const loaded = await loadState(ctx, args);
    if (!loaded.ok) return loaded.result;
    const { state } = loaded;

    let conflicts: unknown[];
    try {
      conflicts = findConflicts(state.docs) as unknown[];
    } catch (err) {
      return fail('Conflict detection failed', describeFailure(err));
    }

    const lines: string[] = ['# kontext conflicts', corpusHeader(state), ''];
    if (conflicts.length === 0) {
      lines.push(
        `No contradictions or duplicates detected across ${state.docs.length} document(s).`,
        'Note the limit of this claim: kontext compares declared subjects, ids, supersedes chains and content',
        'similarity — it does not read for semantic disagreement. Two docs can still contradict each other in prose.',
      );
      return ok(lines.join('\n'));
    }

    lines.push(`${conflicts.length} conflict(s) detected across ${state.docs.length} document(s).`);
    lines.push('Resolve these before treating the docs involved as a single source of truth.');
    lines.push('');
    conflicts.forEach((conflict, index) => {
      lines.push(...renderConflict(conflict, index + 1));
      lines.push('');
    });
    return ok(lines.join('\n'));
  },
};

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export const TOOLS: ToolDefinition[] = [
  packTool,
  freshnessTool,
  searchTool,
  readTool,
  handoffWriteTool,
  handoffReadTool,
  conflictsTool,
];

/** MCP `tools/list` payload. */
export function listTools(): Tool[] {
  return TOOLS.map((tool) => {
    const entry: Tool = {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
    if (tool.annotations !== undefined) entry.annotations = tool.annotations;
    return entry;
  });
}

/**
 * Dispatch a `tools/call`. Never throws: unknown tools, bad arguments and
 * handler failures all come back as structured error content so the agent can
 * correct itself instead of seeing a dead transport.
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<CallToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) {
    return fail(`Unknown tool "${name}"`, [`Available tools: ${TOOLS.map((t) => t.name).join(', ')}.`]);
  }
  try {
    return await tool.handler(args, ctx);
  } catch (err) {
    if (err instanceof ToolInputError) {
      return fail(`Invalid arguments for ${name}`, [
        err.message,
        `Expected: ${JSON.stringify(tool.inputSchema)}`,
      ]);
    }
    return fail(`${name} failed`, describeFailure(err));
  }
}
