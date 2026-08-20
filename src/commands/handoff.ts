/**
 * `kontext handoff` — freeze the current working state into a doc.
 *
 * The acceptance test for the output is blunt: a fresh agent with no prior
 * context should be able to read this file and continue the work. That means
 * spelling out the branch, what has already changed, which docs cover the
 * touched code, and — crucially — which of those docs are not to be trusted.
 *
 * Handoffs rot faster than anything else in a repo, so they are written with
 * `ttlDays: 7` and expire themselves.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { KONTEXT_SPEC_VERSION, type FreshnessReport, type KontextFrontmatter } from '../types.js';
import { loadConfig, findRepoRoot } from '../core/config.js';
import { scanDocs } from '../core/scan.js';
import { assessAll } from '../core/freshness.js';
import { serializeFrontmatter } from '../core/frontmatter.js';
import { isGitRepo } from '../core/git.js';
import { scoreRelevance } from '../core/rank.js';
import { type CommandDef, type FlagSpecs, getBool, getString, parseArgs } from '../util/args.js';
import { SEP, c, err, errWrap, json, markGlyph, out, terminalWidth, truncatePath } from '../util/render.js';

const flags: FlagSpecs = {
  message: { type: 'string', alias: 'm', placeholder: '<m>', description: 'Notes and open questions for whoever picks this up.' },
  task: { type: 'string', alias: 't', placeholder: '<t>', description: 'What the work is, in one line.' },
  out: { type: 'string', alias: 'o', placeholder: '<file>', description: 'Where to write (default: .kontext/handoff.md).' },
  json: { type: 'boolean', description: 'Emit the captured state as JSON as well.' },
};

interface GitState {
  isRepo: boolean;
  branch: string | null;
  head: string | null;
  commits: { sha: string; date: string; subject: string; author: string }[];
  changed: { status: string; path: string }[];
  untracked: string[];
}

/**
 * Run git and return raw stdout with only the trailing newline removed.
 * Trimming the *leading* whitespace would corrupt `status --porcelain`, whose
 * first two columns are the status code and may legitimately begin with a space.
 */
function git(root: string, args: string[]): string | null {
  try {
    const raw = execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return raw.replace(/\n+$/, '');
  } catch {
    return null;
  }
}

const STATUS_WORDS: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'conflicted',
  '?': 'untracked',
};

function describeStatus(code: string): string {
  const letters = code.replace(/\s/g, '').split('');
  const words = letters.map((l) => STATUS_WORDS[l] ?? l).filter((v, i, a) => a.indexOf(v) === i);
  return words.join('/') || 'changed';
}

export function captureGitState(root: string, commitCount = 8): GitState {
  let repo = false;
  try {
    repo = isGitRepo(root);
  } catch {
    repo = false;
  }
  if (!repo) {
    return { isRepo: false, branch: null, head: null, commits: [], changed: [], untracked: [] };
  }

  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() ?? null;
  const head = git(root, ['rev-parse', '--short', 'HEAD'])?.trim() ?? null;
  const SEP_CHAR = '\u001f';
  const logRaw = git(root, ['log', `-n${commitCount}`, `--pretty=format:%h${SEP_CHAR}%aI${SEP_CHAR}%s${SEP_CHAR}%an`]);
  const commits: GitState['commits'] = [];
  if (logRaw) {
    for (const line of logRaw.split('\n')) {
      const parts = line.split(SEP_CHAR);
      if (parts.length < 4) continue;
      commits.push({
        sha: parts[0] ?? '',
        date: parts[1] ?? '',
        subject: parts[2] ?? '',
        author: parts[3] ?? '',
      });
    }
  }

  const statusRaw = git(root, ['status', '--porcelain=v1', '--untracked-files=normal']);
  const changed: GitState['changed'] = [];
  const untracked: string[] = [];
  if (statusRaw) {
    for (const line of statusRaw.split('\n')) {
      if (line.trim() === '') continue;
      // Porcelain v1 is fixed-width: `XY<space>PATH`.
      const code = line.slice(0, 2);
      let path = line.slice(3).replace(/^"|"$/g, '');
      const arrow = path.indexOf(' -> ');
      if (arrow !== -1) path = path.slice(arrow + 4);
      if (path === '' || path.startsWith('.kontext/') || path === '.kontext') continue;
      if (code.trim() === '??') untracked.push(path);
      else changed.push({ status: describeStatus(code), path });
    }
  }

  return { isRepo: true, branch: branch ?? null, head: head ?? null, commits, changed, untracked };
}

/* ------------------------------------------------------------------ */
/* glob matching (local, deliberately minimal)                         */
/* ------------------------------------------------------------------ */

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') re += '[^/]';
    else if (ch !== undefined && '.+^${}()|[]\\'.includes(ch)) re += `\\${ch}`;
    else re += ch ?? '';
  }
  return new RegExp(`^${re}$`);
}

function docCoversAny(report: FreshnessReport, files: string[]): string[] {
  const globs = report.doc.frontmatter.describes ?? [];
  if (globs.length === 0 || files.length === 0) return [];
  const matchers = globs.map((g) => globToRegExp(g.endsWith('/**') ? g : g));
  const hits: string[] = [];
  for (const f of files) {
    for (let i = 0; i < matchers.length; i += 1) {
      const m = matchers[i];
      const g = globs[i];
      if (!m || !g) continue;
      if (m.test(f) || (g.endsWith('/**') && f.startsWith(g.slice(0, -3) + '/'))) {
        hits.push(f);
        break;
      }
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* body                                                                */
/* ------------------------------------------------------------------ */

interface RelevantDoc {
  report: FreshnessReport;
  matched: string[];
  reason: 'covers-changed-files' | 'relevant-to-task' | 'pinned';
}

export function renderHandoffBody(opts: {
  task: string;
  message: string;
  root: string;
  state: GitState;
  relevant: RelevantDoc[];
  counts: Record<string, number>;
  totalDocs: number;
}): string {
  const { task, message, state, relevant, counts, totalDocs } = opts;
  const L: string[] = [];

  L.push(`# Handoff${state.branch ? `: ${state.branch}` : ''}`);
  L.push('');
  L.push(
    'You are picking up work in progress. This file is the whole context — it was generated by `kontext handoff` and assumes you know nothing about what came before.',
  );
  L.push('');

  L.push('## The task');
  L.push('');
  L.push(task.trim() !== '' ? task.trim() : '_No task was recorded. Infer it from the changed files below, and confirm before making changes._');
  L.push('');

  L.push('## Where the work is');
  L.push('');
  if (!state.isRepo) {
    L.push('- Not a git repository, so no branch or commit history was captured.');
  } else {
    L.push(`- Branch: \`${state.branch ?? 'unknown'}\``);
    L.push(`- HEAD: \`${state.head ?? 'unknown'}\``);
    L.push(
      `- Working tree: ${state.changed.length} tracked file(s) changed, ${state.untracked.length} untracked.`,
    );
  }
  L.push('');

  if (state.changed.length > 0 || state.untracked.length > 0) {
    L.push('### Uncommitted changes');
    L.push('');
    L.push('These edits exist only in the working tree. Read them before writing anything.');
    L.push('');
    for (const ch of state.changed) L.push(`- \`${ch.path}\` — ${ch.status}`);
    for (const u of state.untracked.slice(0, 30)) L.push(`- \`${u}\` — untracked (new)`);
    if (state.untracked.length > 30) L.push(`- _(+${state.untracked.length - 30} more untracked)_`);
    L.push('');
  } else if (state.isRepo) {
    L.push('### Uncommitted changes');
    L.push('');
    L.push('_Working tree is clean._');
    L.push('');
  }

  if (state.commits.length > 0) {
    L.push('### Recent commits');
    L.push('');
    for (const c2 of state.commits) {
      L.push(`- \`${c2.sha}\` ${c2.subject} — ${c2.author}, ${c2.date.slice(0, 10)}`);
    }
    L.push('');
  }

  L.push('## Context docs that cover this work');
  L.push('');
  if (relevant.length === 0) {
    L.push(
      '_No doc in this repo declares `describes` globs matching the changed files._ That is itself a finding: the code being edited is undocumented, or the docs that cover it have not declared what they cover. Run `kontext init` to propose claims.',
    );
    L.push('');
  } else {
    L.push('Ordered most-relevant first. **Trust the freshness column, not the prose.**');
    L.push('');
    L.push('| doc | freshness | why it is here |');
    L.push('| --- | --- | --- |');
    for (const r of relevant) {
      const why =
        r.reason === 'covers-changed-files'
          ? `covers ${r.matched.slice(0, 3).map((m) => `\`${m}\``).join(', ')}${r.matched.length > 3 ? ` +${r.matched.length - 3}` : ''}`
          : r.reason === 'pinned'
            ? 'pinned — always relevant'
            : 'lexically relevant to the task';
      L.push(`| \`${r.report.doc.path}\` | ${r.report.freshness} | ${why} |`);
    }
    L.push('');

    const suspect = relevant.filter((r) => r.report.freshness !== 'fresh' && r.report.freshness !== 'unverified');
    if (suspect.length > 0) {
      L.push('### Do not trust these without re-reading the code');
      L.push('');
      for (const r of suspect) {
        L.push(`- \`${r.report.doc.path}\` (**${r.report.freshness}**)`);
        for (const reason of r.report.reasons.slice(0, 3)) L.push(`  - ${reason}`);
      }
      L.push('');
    }
  }

  L.push('### Corpus freshness at handoff time');
  L.push('');
  const summary = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([f, n]) => `${n} ${f}`)
    .join(' · ');
  L.push(`${totalDocs} doc(s) total — ${summary || 'no docs'}.`);
  L.push('');

  L.push('## Open questions and notes');
  L.push('');
  if (message.trim() === '') {
    L.push('_None recorded. Re-run `kontext handoff --message "..."` to capture them._');
  } else {
    const bullets = message
      .split(/\n|(?<=[.?!])\s{1,}(?=[A-Z])/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const b of bullets) L.push(`- ${b}`);
  }
  L.push('');

  L.push('## Suggested first moves');
  L.push('');
  L.push('1. Read the uncommitted changes listed above — they are the most recent intent.');
  if (relevant.length > 0) {
    const fresh = relevant.find((r) => r.report.freshness === 'fresh');
    L.push(
      fresh
        ? `2. Read \`${fresh.report.doc.path}\` — it is the freshest doc covering this code.`
        : `2. Read \`${relevant[0]?.report.doc.path}\`, but verify it against the code first — nothing covering this work is provably fresh.`,
    );
  } else {
    L.push('2. Read the changed source files directly; no doc claims to describe them.');
  }
  L.push('3. Run `kontext check --fix-hints` to see what documentation debt this work is sitting on.');
  L.push('');
  L.push('---');
  L.push('');
  L.push('_This handoff expires 7 days after it was written. After that, regenerate it rather than trusting it._');
  L.push('');

  return L.join('\n');
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

  const task = getString(args, 'task') ?? '';
  const message = getString(args, 'message') ?? '';
  const asJson = getBool(args, 'json');

  const root = findRepoRoot(process.cwd());
  const config = loadConfig(root);
  const docs = await scanDocs(root, config);
  const reports = assessAll(root, docs, config);
  const state = captureGitState(root);

  const changedFiles = [...state.changed.map((ch) => ch.path), ...state.untracked];

  const outFlag = getString(args, 'out');
  const relOut = outFlag ?? join('.kontext', 'handoff.md');
  const abs = isAbsolute(relOut) ? relOut : resolve(root, relOut);
  // A handoff must never cite itself, nor the version of itself it is replacing.
  const selfPath = relative(root, abs).split(sep).join('/');

  const relevant: RelevantDoc[] = [];
  const seen = new Set<string>([selfPath]);
  for (const report of reports) {
    if (report.doc.path === selfPath) continue;
    const matched = docCoversAny(report, changedFiles);
    if (matched.length > 0) {
      relevant.push({ report, matched, reason: 'covers-changed-files' });
      seen.add(report.doc.path);
    }
  }
  for (const report of reports) {
    if (seen.has(report.doc.path)) continue;
    if (report.doc.frontmatter.pin === true) {
      relevant.push({ report, matched: [], reason: 'pinned' });
      seen.add(report.doc.path);
    }
  }
  if (task.trim() !== '') {
    const scored = reports
      .filter((r) => !seen.has(r.doc.path))
      .map((r) => ({ r, score: scoreRelevance(task, r.doc) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    for (const s of scored) {
      relevant.push({ report: s.r, matched: [], reason: 'relevant-to-task' });
      seen.add(s.r.doc.path);
    }
  }

  relevant.sort((a, b) => {
    const order = { 'covers-changed-files': 0, pinned: 1, 'relevant-to-task': 2 } as const;
    return order[a.reason] - order[b.reason] || b.matched.length - a.matched.length || b.report.score - a.report.score;
  });

  const counts: Record<string, number> = {};
  const corpus = reports.filter((r) => r.doc.path !== selfPath);
  for (const r of corpus) counts[r.freshness] = (counts[r.freshness] ?? 0) + 1;

  const body = renderHandoffBody({
    task,
    message,
    root,
    state,
    relevant,
    counts,
    totalDocs: corpus.length,
  });

  const stamp = new Date();
  const frontmatter: Partial<KontextFrontmatter> = {
    kontext: KONTEXT_SPEC_VERSION,
    id: `handoff-${(state.branch ?? 'nobranch').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}-${stamp.toISOString().slice(0, 10)}`,
    kind: 'handoff',
    ttlDays: 7,
    tags: ['handoff', 'generated'],
  };
  const describes = [...new Set(state.changed.map((ch) => ch.path))].slice(0, 20);
  if (describes.length > 0) frontmatter.describes = describes;

  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, serializeFrontmatter(frontmatter, body), 'utf8');

  if (asJson) {
    json({
      path: abs,
      generatedAt: stamp.toISOString(),
      task,
      message,
      git: state,
      frontmatter,
      relevantDocs: relevant.map((r) => ({
        path: r.report.doc.path,
        freshness: r.report.freshness,
        score: r.report.score,
        reason: r.reason,
        matchedFiles: r.matched,
      })),
      corpus: { total: corpus.length, counts },
    });
    return 0;
  }

  // stdout is the path and nothing else, so `kontext handoff | xargs cat` works;
  // it is deliberately never truncated. All commentary goes to stderr.
  out(abs);
  const width = terminalWidth();
  errWrap(
    `handoff captured${SEP}${state.changed.length} changed file(s)${SEP}${relevant.length} relevant doc(s)${SEP}expires in 7 days`,
    width,
    c.dim,
  );
  const suspect = relevant.filter((r) => r.report.freshness !== 'fresh' && r.report.freshness !== 'unverified');
  if (suspect.length > 0) {
    err(c.yellow(`  ${suspect.length} of the relevant doc(s) are not trustworthy:`));
    for (const s of suspect) {
      const tail = ` — ${s.report.freshness}`;
      const room = width - 6 - tail.length;
      err(c.dim(`    ${markGlyph(s.report.freshness)} ${truncatePath(s.report.doc.path, room)}${tail}`));
    }
  }
  return 0;
}

export const handoffCommand: CommandDef = {
  name: 'handoff',
  summary: 'Capture the current working state into a handoff doc.',
  usage: 'kontext handoff [--message <m>] [--task <t>] [--out <file>] [--json]',
  details: [
    'Writes .kontext/handoff.md: branch, recent commits, uncommitted changes, the task,',
    'the docs that declare coverage of the changed files, and which of those docs are',
    'not to be trusted.',
    '',
    'The output is written for a fresh agent with no prior context. It carries',
    '`kind: handoff` and `ttlDays: 7`, so kontext will mark it expired within a week —',
    'handoffs rot faster than anything else in a repo.',
  ].join('\n'),
  flags,
  run,
};

export default handoffCommand;
