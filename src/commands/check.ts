/**
 * `kontext check` — the flagship verdict table, and the CI gate.
 *
 * Every doc gets a verdict, every non-fresh verdict shows the evidence that
 * produced it. If a verdict is listed in `failOn`, the process exits non-zero
 * so this can sit in a pipeline as a hard gate.
 */

import { FRESHNESS_SEVERITY, type Freshness, type FreshnessReport } from '../types.js';
import { loadConfig, findRepoRoot } from '../core/config.js';
import { scanDocs } from '../core/scan.js';
import { assessAll, runVerify } from '../core/freshness.js';
import {
  type CommandDef,
  type FlagSpecs,
  getBool,
  getList,
  parseArgs,
} from '../util/args.js';
import {
  ARROW,
  BULLET,
  SEP,
  banner,
  c,
  err,
  errWrap,
  heading,
  humanTokens,
  joinWrapped,
  json,
  label,
  legendLines,
  mark,
  out,
  outWrap,
  table,
  terminalWidth,
  wrapText,
} from '../util/render.js';

const flags: FlagSpecs = {
  json: { type: 'boolean', description: 'Emit the full report as JSON.' },
  'fix-hints': { type: 'boolean', description: 'Print the concrete next action for each non-fresh doc.' },
  verify: { type: 'boolean', description: "Also run each doc's `verify` command." },
  'fail-on': {
    type: 'list',
    placeholder: '<list>',
    description: 'Verdicts that cause a non-zero exit (overrides config.failOn).',
  },
  'verify-timeout': {
    type: 'number',
    placeholder: '<ms>',
    description: 'Per-doc timeout for verify commands (default 30000).',
  },
};

/** Worst first. Fresh docs sink to the bottom where they belong. */
const ORDER: Freshness[] = (Object.keys(FRESHNESS_SEVERITY) as Freshness[]).sort(
  (a, b) => FRESHNESS_SEVERITY[b] - FRESHNESS_SEVERITY[a],
);

/** A compact evidence blurb for the right-hand column. */
function detail(r: FreshnessReport): string {
  const bits: string[] = [];
  const d = r.drift;
  if (d) {
    if (d.commitsSince > 0) bits.push(`${d.commitsSince} commit${d.commitsSince === 1 ? '' : 's'}`);
    if (d.driftDays > 0) bits.push(`${d.driftDays}d behind`);
    if (d.missingGlobs.length > 0) bits.push(`${d.missingGlobs.length} dead glob${d.missingGlobs.length === 1 ? '' : 's'}`);
    else if (d.matchedFileCount > 0) bits.push(`${d.matchedFileCount} file${d.matchedFileCount === 1 ? '' : 's'}`);
  }
  if (r.verify) bits.push(r.verify.passed ? c.green('verify ok') : c.red('verify FAILED'));
  return c.dim(bits.join(BULLET === '·' ? ' · ' : ' - '));
}

/**
 * The actionable half of the product. A verdict nobody knows how to clear is
 * just nagging, so every verdict maps to one concrete next move.
 */
export function fixHint(r: FreshnessReport): string {
  const path = r.doc.path;
  const describes = r.doc.frontmatter.describes ?? [];
  switch (r.freshness) {
    case 'unverified':
      return `add \`describes\` frontmatter to ${path} naming the source globs it claims to explain — until then staleness is unprovable`;
    case 'orphaned': {
      const dead = r.drift?.missingGlobs ?? describes;
      const moves = (r.drift?.relocations ?? []).filter((m) => m.suggestedGlob !== null);
      if (moves.length > 0) {
        const swaps = moves.map((m) => `\`${m.glob}\` to \`${m.suggestedGlob}\``).join(', ');
        return `git found where the code went — change \`describes\` from ${swaps} (updating the doc restarts its age clock, so read it against the moved code first)`;
      }
      return `\`describes\` matches no files (${dead.join(', ') || 'no globs resolve'}) — repoint it at where that code moved, or delete the doc`;
    }
    case 'expired':
      return `past its \`expires\`/\`ttlDays\` — re-read it, then bump the date or drop the ttl if it is now evergreen`;
    case 'superseded':
      return `superseded by ${(r.supersededBy ?? []).join(', ') || 'a newer doc'} — delete it, or leave a one-line pointer to the replacement`;
    case 'stale': {
      const n = r.drift?.commitsSince ?? 0;
      return n > 0
        ? `review against the ${n} commit${n === 1 ? '' : 's'} since, then bump the doc or narrow \`describes\` to the part that is still true`
        : `code moved after the doc was last touched — review and re-commit the doc, or narrow \`describes\``;
    }
    case 'drifting': {
      const files = (r.drift?.changedFiles ?? []).slice(0, 3);
      return files.length > 0
        ? `skim ${files.join(', ')} for changes this doc should mention`
        : `small drift — a quick read-through will likely clear it`;
    }
    default:
      return `no action needed`;
  }
}

function summaryLines(counts: Record<Freshness, number>, width: number): string[] {
  const parts: string[] = [];
  for (const f of ORDER.slice().reverse()) {
    const n = counts[f];
    if (n > 0) parts.push(`${n} ${label(f)}`);
  }
  return parts.length > 0 ? joinWrapped(parts, SEP, width) : [c.dim('no docs')];
}

async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv, flags);
  if (args.errors.length > 0) {
    for (const e of args.errors) err(c.red(`error: ${e}`));
    return 2;
  }
  if (args.unknown.length > 0) {
    err(c.red(`error: unknown option ${args.unknown.join(', ')}`));
    return 2;
  }

  const asJson = getBool(args, 'json');
  const wantHints = getBool(args, 'fix-hints');
  const wantVerify = getBool(args, 'verify');

  const root = findRepoRoot(process.cwd());
  const config = loadConfig(root);
  const docs = await scanDocs(root, config);
  const reports = assessAll(root, docs, config);

  if (wantVerify) {
    const timeoutFlag = args.flags['verify-timeout'];
    const timeout = typeof timeoutFlag === 'number' ? timeoutFlag : 30_000;
    for (const r of reports) {
      if (!r.doc.frontmatter.verify) continue;
      const result = runVerify(root, r.doc, timeout);
      if (result) r.verify = result;
    }
  }

  const overrides = getList(args, 'fail-on');
  const failOn: Freshness[] =
    overrides.length > 0
      ? overrides.filter((v): v is Freshness => v in FRESHNESS_SEVERITY)
      : config.failOn;

  const badOverrides = overrides.filter((v) => !(v in FRESHNESS_SEVERITY));
  if (badOverrides.length > 0) {
    err(c.yellow(`warning: ignoring unknown verdict(s) in --fail-on: ${badOverrides.join(', ')}`));
  }
  if (overrides.length > 0 && failOn.length === 0) {
    // Silently degrading to "gate disabled" is how a CI check quietly stops working.
    err(c.red(`error: --fail-on had no recognised verdicts — expected some of ${Object.keys(FRESHNESS_SEVERITY).join(', ')}`));
    return 2;
  }

  const counts = Object.fromEntries(ORDER.map((f) => [f, 0])) as Record<Freshness, number>;
  for (const r of reports) counts[r.freshness] += 1;

  const failing = reports.filter(
    (r) => failOn.includes(r.freshness) || (r.verify !== undefined && !r.verify.passed),
  );
  const exitCode = failing.length > 0 ? 1 : 0;

  if (asJson) {
    json({
      root,
      generatedAt: new Date().toISOString(),
      total: reports.length,
      counts,
      failOn,
      failed: failing.map((r) => r.doc.path),
      exitCode,
      docs: reports.map((r) => ({
        path: r.doc.path,
        title: r.doc.title,
        kind: r.doc.frontmatter.kind ?? null,
        id: r.doc.frontmatter.id ?? null,
        owner: r.doc.frontmatter.owner ?? null,
        describes: r.doc.frontmatter.describes ?? [],
        tokenEstimate: r.doc.tokenEstimate,
        freshness: r.freshness,
        score: r.score,
        reasons: r.reasons,
        drift: r.drift ?? null,
        verify: r.verify ?? null,
        supersededBy: r.supersededBy ?? null,
        hint: r.freshness === 'fresh' ? null : fixHint(r),
      })),
    });
    return exitCode;
  }

  const width = terminalWidth();

  if (reports.length === 0) {
    outWrap(`no markdown matched ${config.include.join(', ')} under ${root}`, width, c.dim);
    outWrap('try `kontext doctor` to see why', width, c.dim);
    return 0;
  }

  const totalTokens = reports.reduce((a, r) => a + r.doc.tokenEstimate, 0);
  out();
  out(
    banner(
      'kontext check',
      [`${reports.length} doc${reports.length === 1 ? '' : 's'}`, `~${humanTokens(totalTokens)} tokens`],
      root,
      width,
    ),
  );
  out();

  const grouped = new Map<Freshness, FreshnessReport[]>();
  for (const r of reports) {
    const list = grouped.get(r.freshness);
    if (list) list.push(r);
    else grouped.set(r.freshness, [r]);
  }

  for (const freshness of ORDER) {
    const group = grouped.get(freshness);
    if (!group || group.length === 0) continue;
    group.sort((a, b) => a.score - b.score || a.doc.path.localeCompare(b.doc.path));

    out(heading(`${freshness} (${group.length})`, width));

    const rows = group.map((r) => [
      ` ${mark(r.freshness)}`,
      r.doc.path,
      c.dim(String(r.score).padStart(3)),
      detail(r),
    ]);
    const lines = table(rows, [{}, { flex: true, path: true }, { align: 'right' }, { flex: true }], 2, width);

    for (let i = 0; i < group.length; i += 1) {
      const r = group[i];
      const line = lines[i];
      if (!r || line === undefined) continue;
      out(line);
      if (freshness !== 'fresh') {
        for (const reason of r.reasons.slice(0, 4)) {
          const wrapped = wrapText(reason, width - 9, '');
          wrapped.forEach((l, n) => out(c.dim(n === 0 ? `     ${BULLET} ${l}` : `       ${l}`)));
        }
        if (r.verify && !r.verify.passed) {
          const first = r.verify.output.split('\n').find((s) => s.trim() !== '') ?? '';
          out(c.dim(`     ${BULLET} verify \`${r.verify.command}\` exited ${r.verify.exitCode}`));
          if (first) out(c.dim(`       ${first.slice(0, Math.max(10, width - 8))}`));
        }
        if (wantHints) {
          const wrapped = wrapText(fixHint(r), width - 9, '');
          wrapped.forEach((l, n) => out(c.yellow(n === 0 ? `     ${ARROW} ${l}` : `       ${l}`)));
        }
      }
    }
    out();
  }

  for (const line of summaryLines(counts, width)) out(line);
  for (const line of legendLines(width)) out(line);
  if (!wantHints && counts.fresh < reports.length) {
    outWrap('run `kontext check --fix-hints` for the next action on each', width, c.dim);
  }
  out();

  if (exitCode !== 0) {
    errWrap(
      `check failed: ${failing.length} doc${failing.length === 1 ? '' : 's'} in fail set [${failOn.join(', ')}]`,
      width,
      c.red,
    );
  }
  return exitCode;
}

export const checkCommand: CommandDef = {
  name: 'check',
  summary: 'Assess every doc, print verdicts with evidence, gate CI.',
  usage: 'kontext check [--json] [--fix-hints] [--verify] [--fail-on <list>]',
  details: [
    'Groups docs worst-first and shows, under each non-fresh doc, the git evidence',
    'behind its verdict. Exits 1 when any doc lands in the fail set, which by default',
    'comes from `failOn` in kontext.config.json (stale, expired, orphaned).',
    '',
    'With --verify, docs declaring a `verify` command have it executed; a failing',
    'verify also fails the run regardless of --fail-on.',
  ].join('\n'),
  flags,
  run,
};

export default checkCommand;
