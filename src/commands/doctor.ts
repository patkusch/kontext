/**
 * `kontext doctor` — diagnose the setup, and demonstrate the problem.
 *
 * Doubles as the sales pitch: run it on any repo that has never heard of
 * kontext and it will tell you, with numbers, how much of your documentation is
 * unfalsifiable.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DocRecord } from '../types.js';
import { loadConfig, findRepoRoot } from '../core/config.js';
import { scanDocs } from '../core/scan.js';
import { assessAll } from '../core/freshness.js';
import { findConflicts, type Conflict } from '../core/conflicts.js';
import { isGitRepo } from '../core/git.js';
import { type CommandDef, type FlagSpecs, getBool, parseArgs } from '../util/args.js';
import {
  SEP,
  banner,
  bar,
  c,
  displayWidth,
  err,
  humanTokens,
  json,
  out,
  terminalWidth,
  truncate,
  wrapText,
} from '../util/render.js';

const flags: FlagSpecs = {
  json: { type: 'boolean', description: 'Emit the diagnosis as JSON.' },
};

type Severity = 'blocker' | 'major' | 'minor' | 'ok';

interface Finding {
  severity: Severity;
  title: string;
  /** What to actually do about it. */
  fix: string;
}

const SEV_ORDER: Severity[] = ['blocker', 'major', 'minor', 'ok'];
const SEV_PAINT: Record<Severity, (s: string) => string> = {
  blocker: c.red,
  major: c.yellow,
  minor: c.blue,
  ok: c.green,
};

/**
 * `Conflict`'s exact field names belong to another layer; read it structurally
 * so doctor keeps rendering even if that shape shifts.
 */
function describeConflict(conflict: Conflict): { kind: string; paths: string[]; detail: string } {
  const rec = conflict as unknown as Record<string, unknown>;
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) if (rec[k] !== undefined) return rec[k];
    return undefined;
  };
  const kindRaw = pick('kind', 'type', 'reason');
  const kind = typeof kindRaw === 'string' ? kindRaw : 'conflict';

  const pathsRaw = pick('paths', 'docs', 'files', 'members');
  const paths: string[] = Array.isArray(pathsRaw)
    ? pathsRaw.map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') {
          const o = p as Record<string, unknown>;
          const v = o['path'] ?? o['id'] ?? o['title'];
          if (typeof v === 'string') return v;
        }
        return String(p);
      })
    : [];

  const detailRaw = pick('detail', 'message', 'description', 'id', 'value');
  const detail = typeof detailRaw === 'string' ? detailRaw : '';
  return { kind, paths, detail };
}

function gitCommitCount(root: string): number | null {
  try {
    const outStr = execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const n = Number(outStr);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function duplicateIds(docs: DocRecord[]): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const d of docs) {
    const id = d.frontmatter.id;
    if (typeof id !== 'string' || id === '') continue;
    const list = byId.get(id);
    if (list) list.push(d.path);
    else byId.set(id, [d.path]);
  }
  for (const [id, paths] of [...byId.entries()]) {
    if (paths.length < 2) byId.delete(id);
  }
  return byId;
}

function pct(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((n / total) * 100);
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
  const width = terminalWidth();

  const root = findRepoRoot(process.cwd());
  const config = loadConfig(root);

  let repo = false;
  try {
    repo = isGitRepo(root);
  } catch {
    repo = false;
  }
  const commits = repo ? gitCommitCount(root) : null;

  const docs = await scanDocs(root, config);
  const reports = repo ? assessAll(root, docs, config) : [];

  const withFrontmatter = docs.filter((d) => d.hasFrontmatter);
  const withDescribes = docs.filter(
    (d) => Array.isArray(d.frontmatter.describes) && d.frontmatter.describes.length > 0,
  );
  const withVerify = docs.filter((d) => typeof d.frontmatter.verify === 'string' && d.frontmatter.verify !== '');
  const unprovable = docs.length - withDescribes.length;
  const totalTokens = docs.reduce((a, d) => a + d.tokenEstimate, 0);

  let conflicts: Conflict[] = [];
  try {
    conflicts = findConflicts(docs);
  } catch {
    conflicts = [];
  }
  const dupes = duplicateIds(docs);

  const configPath = join(root, 'kontext.config.json');
  const configExists = existsSync(configPath);

  const counts: Record<string, number> = {};
  for (const r of reports) counts[r.freshness] = (counts[r.freshness] ?? 0) + 1;
  const notFresh = reports.filter((r) => r.freshness !== 'fresh' && r.freshness !== 'unverified').length;

  /* ---------------- findings, worst first ---------------- */
  const findings: Finding[] = [];

  if (!repo) {
    findings.push({
      severity: 'blocker',
      title: 'not a git repository',
      fix: 'kontext proves staleness from commit history. Run `git init` and commit, or run kontext inside the repo that owns these docs.',
    });
  } else if (commits === 0 || commits === null) {
    findings.push({
      severity: 'blocker',
      title: 'git repo has no commits',
      fix: 'Make at least one commit. With no history there is nothing to compare a doc against.',
    });
  }

  if (docs.length === 0) {
    findings.push({
      severity: 'blocker',
      title: 'no markdown files matched',
      fix: `Nothing matched ${config.include.join(', ')} (excluding ${config.exclude.length} patterns). Widen \`include\` in kontext.config.json.`,
    });
  }

  if (docs.length > 0 && withDescribes.length === 0) {
    findings.push({
      severity: 'major',
      title: `0 of ${docs.length} docs declare \`describes\` — nothing is falsifiable`,
      fix: 'Run `kontext init` to infer candidate `describes` globs from the paths your docs already cite, then review them.',
    });
  } else if (unprovable > 0) {
    findings.push({
      severity: unprovable > docs.length / 2 ? 'major' : 'minor',
      title: `${unprovable} of ${docs.length} docs (${pct(unprovable, docs.length)}%) have no \`describes\` claim`,
      fix: 'Those docs can never be proven stale or fresh. Run `kontext init` for proposals, or add `describes` by hand to the ones that matter.',
    });
  }

  if (dupes.size > 0) {
    findings.push({
      severity: 'major',
      title: `${dupes.size} duplicate doc id(s): ${[...dupes.keys()].slice(0, 5).join(', ')}`,
      fix: 'Ids must be unique — `supersedes` and pack references resolve through them. Rename the collisions.',
    });
  }

  if (conflicts.length > 0) {
    findings.push({
      severity: 'major',
      title: `${conflicts.length} conflict(s) between docs`,
      fix: 'Two or more docs are making competing claims about the same code. Merge them, or mark the loser with `supersedes`.',
    });
  }

  if (notFresh > 0) {
    findings.push({
      severity: notFresh > reports.length / 3 ? 'major' : 'minor',
      title: `${notFresh} doc(s) are drifting, stale, expired, orphaned or superseded`,
      fix: 'Run `kontext check --fix-hints` for the per-doc next action.',
    });
  }

  const relocated = reports.filter((r) =>
    (r.drift?.relocations ?? []).some((m) => m.suggestedGlob !== null),
  ).length;
  if (relocated > 0) {
    findings.push({
      severity: 'major',
      title: `${relocated} doc(s) describe code that has moved to a new place`,
      fix: 'Their `describes` globs match nothing, but git can show where the files went. Run `kontext check --fix-hints` to see the new glob for each, then update the doc.',
    });
  }

  if (!configExists) {
    findings.push({
      severity: 'minor',
      title: 'no kontext.config.json — running on defaults',
      fix: 'Run `kontext init` to write a starter config, then tune warnDriftDays / staleDriftDays / failOn to your repo.',
    });
  }

  if (docs.length > 0 && withVerify.length === 0) {
    findings.push({
      severity: 'minor',
      title: 'no doc declares a `verify` command',
      fix: 'A `verify:` command (a test, a script) upgrades a doc from "probably true" to "proven true". Add one to your most load-bearing doc.',
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: 'ok',
      title: 'nothing to fix — every doc is claimed, provable and fresh',
      fix: 'Wire `kontext check` into CI so it stays that way.',
    });
  }

  findings.sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
  const blockers = findings.filter((f) => f.severity === 'blocker').length;

  if (asJson) {
    json({
      root,
      generatedAt: new Date().toISOString(),
      git: { isRepo: repo, commits },
      config: { path: configPath, exists: configExists, include: config.include, exclude: config.exclude, failOn: config.failOn },
      corpus: {
        docs: docs.length,
        tokenEstimate: totalTokens,
        withFrontmatter: withFrontmatter.length,
        withDescribes: withDescribes.length,
        withVerify: withVerify.length,
        unprovable,
        unprovablePct: pct(unprovable, docs.length),
        freshnessCounts: counts,
      },
      duplicateIds: Object.fromEntries(dupes),
      conflicts: conflicts.map(describeConflict),
      findings,
      exitCode: blockers > 0 ? 1 : 0,
    });
    return blockers > 0 ? 1 : 0;
  }

  out();
  out(banner('kontext doctor', [], root, width));
  out();

  const stat = (labelText: string, value: string, note = ''): void => {
    out(`  ${c.dim(labelText.padEnd(22))} ${value}${note ? `  ${c.dim(note)}` : ''}`);
  };

  stat('git repository', repo ? c.green('yes') : c.red('no'));
  stat('commits', commits === null ? c.red('none') : commits === 0 ? c.red('0') : c.green(String(commits)));
  stat('config', configExists ? c.green('kontext.config.json') : c.yellow('defaults (no config file)'));
  stat('docs managed', String(docs.length), `~${humanTokens(totalTokens)} tokens`);
  stat(
    'with frontmatter',
    `${withFrontmatter.length}/${docs.length}`,
    `${pct(withFrontmatter.length, docs.length)}%`,
  );
  stat(
    'with `describes`',
    `${withDescribes.length}/${docs.length}`,
    `${pct(withDescribes.length, docs.length)}% provable`,
  );
  stat('with `verify`', `${withVerify.length}/${docs.length}`);
  stat('duplicate ids', dupes.size === 0 ? c.green('0') : c.red(String(dupes.size)));
  stat('conflicts', conflicts.length === 0 ? c.green('0') : c.red(String(conflicts.length)));
  out();

  if (docs.length > 0) {
    const provable = withDescribes.length;
    const note = `${unprovable} doc(s) kontext cannot judge`;
    const pctText = `${pct(provable, docs.length)}%`;
    const fixed = 2 + displayWidth('provable') + 1 + 1 + displayWidth(pctText) + 2;
    const room = width - fixed;
    // Below a certain width the note cannot share the line with the bar.
    const inline = room - displayWidth(note) >= 6;
    const barWidth = Math.max(6, Math.min(30, inline ? room - displayWidth(note) : room));
    out(
      `  ${c.dim('provable')} ${bar(provable / docs.length, barWidth)} ${pctText}${inline ? `  ${c.dim(note)}` : ''}`,
    );
    if (!inline) for (const line of wrapText(note, width - 2)) out(c.dim(`  ${line}`));
    out();
  }

  if (dupes.size > 0) {
    out(c.bold('duplicate ids'));
    for (const [id, paths] of [...dupes.entries()].slice(0, 8)) {
      out(`  ${c.red(id)} ${c.dim(`— ${paths.map((p) => truncate(p, 40)).join(', ')}`)}`);
    }
    out();
  }

  if (conflicts.length > 0) {
    out(c.bold('conflicts'));
    for (const conflict of conflicts.slice(0, 8)) {
      const d = describeConflict(conflict);
      out(`  ${c.red(d.kind)} ${c.dim(d.paths.map((p) => truncate(p, 36)).join(' ↔ ') || d.detail)}`);
      if (d.detail && d.paths.length > 0) out(c.dim(`    ${truncate(d.detail, width - 6)}`));
    }
    if (conflicts.length > 8) out(c.dim(`  (+${conflicts.length - 8} more)`));
    out();
  }

  out(c.bold('fix these, in this order'));
  out();
  let n = 1;
  for (const f of findings) {
    const tag = SEV_PAINT[f.severity](f.severity.padEnd(7));
    const titleLines = wrapText(f.title, width - 14);
    titleLines.forEach((line, i) => {
      out(i === 0 ? `  ${c.dim(`${n}.`)} ${tag} ${line}` : `             ${line}`);
    });
    for (const line of wrapText(f.fix, width - 14)) out(c.dim(`         ${line}`));
    out();
    n += 1;
  }

  return blockers > 0 ? 1 : 0;
}

export const doctorCommand: CommandDef = {
  name: 'doctor',
  summary: 'Diagnose the setup and rank what to fix first.',
  usage: 'kontext doctor [--json]',
  details: [
    'Checks the things kontext needs to work at all (a git repo with history, docs it',
    'can see, a config) and the things that make its verdicts meaningful (docs that',
    'declare `describes`, unique ids, no conflicting claims).',
    '',
    'Exits 1 when a blocker is present, 0 otherwise.',
  ].join('\n'),
  flags,
  run,
};

export default doctorCommand;
