/**
 * kontext — public library entry point.
 *
 * Everything the CLI and the MCP server are built from is exported here, so a
 * doc lifecycle can be wired into someone else's tooling directly:
 *
 * ```ts
 * import { findRepoRoot, loadConfig, scanDocs, assessAll } from 'kontext';
 *
 * const root = findRepoRoot(process.cwd());
 * const config = loadConfig(root);
 * const reports = assessAll(root, await scanDocs(root, config), config);
 * const rotten = reports.filter((r) => r.freshness === 'stale');
 * ```
 */

/** The shared contract: DocRecord, FreshnessReport, ContextPack, config, and friends. */
export * from './types.js';

/** Config discovery and repo-root resolution. */
export { loadConfig, findRepoRoot } from './core/config.js';

/** Reading markdown into DocRecords. */
export { scanDocs, readDoc } from './core/scan.js';

/** Turning DocRecords into git-proven freshness verdicts. */
export { assessAll } from './core/freshness.js';

/** Ranking and budgeting context for a task. */
export { buildPack, scoreRelevance } from './core/rank.js';

/** Contradiction and duplicate detection across the corpus. */
export { findConflicts } from './core/conflicts.js';

/** Rough token accounting — good enough for budgeting, not for billing. */
export { estimateTokens } from './util/tokens.js';

import type { findConflicts as findConflictsFn } from './core/conflicts.js';

/**
 * One detected contradiction or duplicate, as produced by {@link findConflicts}.
 * Derived from the implementation so the public name never drifts from it.
 */
export type Conflict = ReturnType<typeof findConflictsFn>[number];
