/**
 * `kontext map` — the inventory view.
 *
 * `check` answers "what is broken". `map` answers the more uncomfortable
 * question: "what do I actually have?" It is a freshness heatmap over the whole
 * corpus, with token weight, because token weight is what context costs.
 */

import { FRESHNESS_SEVERITY, type DocKind, type Freshness, type FreshnessReport } from '../types.js';
import { loadConfig, findRepoRoot } from '../core/config.js';
import { scanDocs } from '../core/scan.js';
import { assessAll } from '../core/freshness.js';
import { type CommandDef, type FlagSpecs, getBool, getString, parseArgs } from '../util/args.js';
import {
  type Column,
  SEP,
  TREE_END,
  TREE_MID,
  banner,
  c,
  displayWidth,
  err,
  humanTokens,
  joinWrapped,
  json,
  legendLines,
  mark,
  markGlyph,
  out,
  outWrap,
  paint,
  table,
  terminalWidth,
  truncatePath,
} from '../util/render.js';

type GroupBy = 'kind' | 'freshness' | 'dir';

const flags: FlagSpecs = {
  json: { type: 'boolean', description: 'Emit the inventory as JSON.' },
  by: {
    type: 'string',
    placeholder: '<kind|freshness|dir>',
    default: 'dir',
    description: 'How to group the corpus (default: dir).',
  },
};

const SEVERITY_ORDER: Freshness[] = (Object.keys(FRESHNESS_SEVERITY) as Freshness[]).sort(
  (a, b) => FRESHNESS_SEVERITY[b] - FRESHNESS_SEVERITY[a],
);

function groupKey(by: GroupBy, r: FreshnessReport): string {
  if (by === 'freshness') return r.freshness;
  if (by === 'kind') return (r.doc.frontmatter.kind as DocKind | undefined) ?? 'unclassified';
  const idx = r.doc.path.lastIndexOf('/');
  return idx === -1 ? '.' : r.doc.path.slice(0, idx);
}

/** One glyph per doc, worst-first: the heatmap strip for a group. */
function strip(reports: FreshnessReport[], budget: number): string {
  const sorted = reports
    .slice()
    .sort((a, b) => FRESHNESS_SEVERITY[b.freshness] - FRESHNESS_SEVERITY[a.freshness]);
  if (sorted.length <= budget) {
    return sorted.map((r) => paint(r.freshness, markGlyph(r.freshness))).join('');
  }
  // Too many to show one-per-doc: collapse into proportional runs.
  const counts = new Map<Freshness, number>();
  for (const r of sorted) counts.set(r.freshness, (counts.get(r.freshness) ?? 0) + 1);
  let outStr = '';
  for (const f of SEVERITY_ORDER) {
    const n = counts.get(f) ?? 0;
    if (n === 0) continue;
    const cells = Math.max(1, Math.round((n / sorted.length) * budget));
    outStr += paint(f, markGlyph(f).repeat(cells));
  }
  return outStr;
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

  const byRaw = getString(args, 'by', 'dir') ?? 'dir';
  if (byRaw !== 'kind' && byRaw !== 'freshness' && byRaw !== 'dir') {
    err(c.red(`error: --by expects one of kind, freshness, dir (got ${byRaw})`));
    return 2;
  }
  const by: GroupBy = byRaw;
  const asJson = getBool(args, 'json');

  const root = findRepoRoot(process.cwd());
  const config = loadConfig(root);
  const docs = await scanDocs(root, config);
  const reports = assessAll(root, docs, config);

  const totalTokens = reports.reduce((a, r) => a + r.doc.tokenEstimate, 0);
  const counts = Object.fromEntries(SEVERITY_ORDER.map((f) => [f, 0])) as Record<Freshness, number>;
  for (const r of reports) counts[r.freshness] += 1;
  const unverified = counts.unverified;
  const unverifiedPct = reports.length === 0 ? 0 : Math.round((unverified / reports.length) * 100);

  const groups = new Map<string, FreshnessReport[]>();
  for (const r of reports) {
    const key = groupKey(by, r);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const orderedKeys = [...groups.keys()].sort((a, b) => {
    if (by === 'freshness') {
      return (FRESHNESS_SEVERITY[b as Freshness] ?? 0) - (FRESHNESS_SEVERITY[a as Freshness] ?? 0);
    }
    const ga = groups.get(a) ?? [];
    const gb = groups.get(b) ?? [];
    const ta = ga.reduce((x, r) => x + r.doc.tokenEstimate, 0);
    const tb = gb.reduce((x, r) => x + r.doc.tokenEstimate, 0);
    return tb - ta || a.localeCompare(b);
  });

  if (asJson) {
    json({
      root,
      generatedAt: new Date().toISOString(),
      groupedBy: by,
      totals: {
        docs: reports.length,
        tokenEstimate: totalTokens,
        unverified,
        unverifiedPct,
        counts,
      },
      groups: orderedKeys.map((key) => {
        const group = groups.get(key) ?? [];
        return {
          key,
          docs: group.length,
          tokenEstimate: group.reduce((a, r) => a + r.doc.tokenEstimate, 0),
          entries: group.map((r) => ({
            path: r.doc.path,
            title: r.doc.title,
            id: r.doc.frontmatter.id ?? null,
            kind: r.doc.frontmatter.kind ?? null,
            freshness: r.freshness,
            score: r.score,
            tokenEstimate: r.doc.tokenEstimate,
            describes: r.doc.frontmatter.describes ?? [],
          })),
        };
      }),
    });
    return 0;
  }

  const width = terminalWidth();

  if (reports.length === 0) {
    outWrap(`no markdown matched ${config.include.join(', ')} under ${root}`, width, c.dim);
    return 0;
  }

  out();
  out(banner('kontext map', [`grouped by ${by}`], root, width));
  out();

  for (const key of orderedKeys) {
    const group = (groups.get(key) ?? [])
      .slice()
      .sort(
        (a, b) =>
          FRESHNESS_SEVERITY[b.freshness] - FRESHNESS_SEVERITY[a.freshness] ||
          b.doc.tokenEstimate - a.doc.tokenEstimate ||
          a.doc.path.localeCompare(b.doc.path),
      );
    const groupTokens = group.reduce((a, r) => a + r.doc.tokenEstimate, 0);
    const heatWidth = Math.max(4, Math.min(24, width - 44));
    const heat = strip(group, heatWidth);
    const meta = `${group.length} doc${group.length === 1 ? '' : 's'}${SEP}~${humanTokens(groupTokens)} tokens`;
    // Group keys are directory paths and can be arbitrarily deep.
    const keyRoom = Math.max(6, width - displayWidth(meta) - heatWidth - 3);
    out(`${c.bold(truncatePath(key, keyRoom))} ${c.dim(meta)}  ${heat}`);

    // Don't repeat the grouping dimension in every row.
    const showKind = by !== 'kind';
    const showFreshness = by !== 'freshness';

    const rows = group.map((r, i) => {
      const branch = i === group.length - 1 ? TREE_END : TREE_MID;
      const name = by === 'dir' ? (r.doc.path.split('/').pop() ?? r.doc.path) : r.doc.path;
      const kind = r.doc.frontmatter.kind ?? '';
      const row = [`${c.dim(branch)} ${mark(r.freshness)}`, name];
      if (showKind) row.push(kind ? c.dim(kind) : c.dim('—'));
      row.push(c.dim(`~${humanTokens(r.doc.tokenEstimate)}`));
      if (showFreshness) row.push(paint(r.freshness, r.freshness));
      return row;
    });
    const cols: Column[] = [{}, { flex: true, path: true }];
    if (showKind) cols.push({ max: 12 });
    cols.push({ align: 'right', max: 7 });
    if (showFreshness) cols.push({ max: 11 });

    for (const line of table(rows, cols, 2, width)) out(line);
    out();
  }

  const verdictBits = SEVERITY_ORDER.slice()
    .reverse()
    .filter((f) => counts[f] > 0)
    .map((f) => `${paint(f, String(counts[f]))} ${f}`);

  for (const line of joinWrapped(
    [`${c.bold(String(reports.length))} docs`, `~${humanTokens(totalTokens)} tokens`, `${unverifiedPct}% unverified`],
    SEP,
    width,
  )) {
    out(line);
  }
  for (const line of joinWrapped(verdictBits.map((b) => c.dim(b)), SEP, width)) out(line);
  for (const line of legendLines(width)) out(line);
  out();
  return 0;
}

export const mapCommand: CommandDef = {
  name: 'map',
  summary: 'Freshness heatmap over the whole doc corpus.',
  usage: 'kontext map [--json] [--by <kind|freshness|dir>]',
  details: [
    'Inventories every managed markdown file with a freshness marker, its kind and',
    'its token weight, then totals the corpus. The percentage of unverified docs is',
    'the number to watch: those are docs kontext cannot prove anything about.',
  ].join('\n'),
  flags,
  run,
};

export default mapCommand;
