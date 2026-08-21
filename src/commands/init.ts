/**
 * `kontext init` — the adoption on-ramp.
 *
 * Nobody hand-writes frontmatter for 200 existing docs, so kontext guesses:
 * an id from the filename, a kind from path and heading shape, and — the
 * load-bearing one — candidate `describes` globs mined from the code paths and
 * imports the doc's own body already mentions.
 *
 * The guesses are labelled as guesses. A tool that quietly asserts inferred
 * facts would be the exact disease this project treats.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_CONFIG, type DocKind, type DocRecord, type KontextFrontmatter } from '../types.js';
import { KONTEXT_SPEC_VERSION } from '../types.js';
import { loadConfig, findRepoRoot, isHomeDirRoot, WIDE_SCOPE_DOC_COUNT } from '../core/config.js';
import { scanDocs } from '../core/scan.js';
import { serializeFrontmatter } from '../core/frontmatter.js';
import { listTrackedFiles } from '../core/git.js';
import { type CommandDef, type FlagSpecs, getBool, parseArgs } from '../util/args.js';
import { SEP, banner, c, err, json, out, outWrap, terminalWidth, truncate } from '../util/render.js';

const flags: FlagSpecs = {
  'dry-run': { type: 'boolean', description: 'Preview only. Never writes, even with --yes.' },
  yes: { type: 'boolean', alias: 'y', description: 'Actually write the inferred frontmatter and starter config.' },
  force: { type: 'boolean', description: 'Override the scope safety check. Read what it says first.' },
  json: { type: 'boolean', description: 'Emit the proposals as JSON.' },
};

const REVIEW_COMMENT = 'INFERRED by `kontext init` — review before trusting';

export interface Proposal {
  path: string;
  frontmatter: Partial<KontextFrontmatter>;
  /** Why each inferred field was chosen — printed so the guess is auditable. */
  notes: Record<string, string>;
  /** Concrete source files the body mentioned, before glob collapsing. */
  evidence: string[];
  confidence: 'high' | 'medium' | 'low';
}

/* ------------------------------------------------------------------ */
/* id inference                                                        */
/* ------------------------------------------------------------------ */

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.(md|mdx)$/, '')
    .replace(/^\d{1,4}[-_]/, '') // ADR number prefixes: 0003-use-postgres -> use-postgres
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function inferId(path: string, taken: Set<string>): string {
  const parts = path.split('/');
  const file = parts[parts.length - 1] ?? path;
  const base = slugify(file);
  const parent = slugify(parts[parts.length - 2] ?? '');

  let candidate = base;
  if (base === 'readme' || base === 'index' || base === '') {
    candidate = parent ? (base === '' ? parent : `${parent}-${base}`) : base || 'doc';
  }
  if (candidate === '') candidate = 'doc';
  if (!taken.has(candidate)) return candidate;

  // Disambiguate by walking up the path rather than appending meaningless -2.
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const seg = slugify(parts[i] ?? '');
    if (!seg) continue;
    candidate = `${seg}-${candidate}`;
    if (!taken.has(candidate)) return candidate;
  }
  let n = 2;
  while (taken.has(`${candidate}-${n}`)) n += 1;
  return `${candidate}-${n}`;
}

/* ------------------------------------------------------------------ */
/* kind inference                                                      */
/* ------------------------------------------------------------------ */

const IMPERATIVE = /^(run|install|deploy|restart|check|open|click|set|export|ssh|kubectl|curl|scale|rollback|verify|stop|start|apply|create|delete)\b/i;

export function inferKind(doc: DocRecord): { kind: DocKind; why: string } {
  const path = doc.path.toLowerCase();
  const file = path.split('/').pop() ?? path;
  const headings = doc.headings.map((h) => h.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim());
  const has = (...names: string[]) => names.some((n) => headings.some((h) => h === n || h.startsWith(`${n} `)));

  if (path.includes('handoff') || file.startsWith('handoff')) {
    return { kind: 'handoff', why: 'path mentions handoff' };
  }
  if (/\/(adr|adrs|decisions?)\//.test(path) || /^\d{3,4}-/.test(file)) {
    return { kind: 'decision', why: 'path looks like an ADR directory or numbered decision record' };
  }
  if (has('decision', 'consequences') && has('context')) {
    return { kind: 'decision', why: 'headings follow the Context/Decision/Consequences ADR shape' };
  }
  if (file === 'readme.md' || file === 'readme.mdx' || file === 'index.md' || file === 'index.mdx') {
    return { kind: 'index', why: 'README/index files map other docs' };
  }
  if (/runbook|playbook|oncall|on-call|operations|\/ops\//.test(path) || has('runbook', 'steps', 'procedure', 'rollback', 'escalation')) {
    return { kind: 'runbook', why: 'path or headings signal operational steps' };
  }
  if (/\/(spec|specs|rfc|rfcs|design)\//.test(path) || has('requirements', 'non goals', 'nongoals', 'acceptance criteria', 'scope')) {
    return { kind: 'spec', why: 'path or headings signal a contract others implement against' };
  }
  if (/reference|\/api\/|schema|glossary|changelog/.test(path) || has('api', 'reference', 'schema', 'endpoints', 'parameters', 'options')) {
    return { kind: 'reference', why: 'path or headings signal lookup material' };
  }

  // Fall back to body shape: a doc that is mostly ordered imperative steps is a runbook.
  const lines = doc.body.split('\n');
  let steps = 0;
  for (const line of lines) {
    const m = /^\s*(?:\d+[.)]|[-*])\s+(.*)$/.exec(line);
    if (m && m[1] && IMPERATIVE.test(m[1])) steps += 1;
  }
  if (steps >= 4) return { kind: 'runbook', why: `${steps} imperative list items read as procedure steps` };

  return { kind: 'guide', why: 'no stronger signal — defaulted' };
}

/* ------------------------------------------------------------------ */
/* describes inference                                                 */
/* ------------------------------------------------------------------ */

const PATHISH = /(?:^|[\s`'"(\[<])((?:\.{0,2}\/)?[\w@.\-]+(?:\/[\w@.\-]+)+\.[A-Za-z]{1,6})/g;
const IMPORTISH = /(?:from|import|require\(|include|source)\s*['"`]([^'"`]+)['"`]/g;
const BARE_FILE = /`([\w.\-]+\.[A-Za-z]{1,6})`/g;

const CODE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'rb', 'java', 'kt', 'swift',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'scala', 'sql', 'proto', 'graphql', 'gql',
  'yaml', 'yml', 'toml', 'json', 'tf', 'sh', 'vue', 'svelte',
]);

function extOf(p: string): string {
  const i = p.lastIndexOf('.');
  return i === -1 ? '' : p.slice(i + 1).toLowerCase();
}

/** Index of tracked source files, for resolving loose mentions to real paths. */
export interface SourceIndex {
  paths: Set<string>;
  byBasename: Map<string, string[]>;
  bySuffix: Map<string, string[]>;
}

export function buildSourceIndex(files: string[]): SourceIndex {
  const paths = new Set<string>();
  const byBasename = new Map<string, string[]>();
  const bySuffix = new Map<string, string[]>();
  for (const f of files) {
    if (f.endsWith('.md') || f.endsWith('.mdx')) continue;
    if (!CODE_EXT.has(extOf(f))) continue;
    paths.add(f);
    const base = f.split('/').pop() ?? f;
    const list = byBasename.get(base);
    if (list) list.push(f);
    else byBasename.set(base, [f]);

    const segs = f.split('/');
    for (let i = 1; i < segs.length; i += 1) {
      const suffix = segs.slice(i).join('/');
      const s = bySuffix.get(suffix);
      if (s) s.push(f);
      else bySuffix.set(suffix, [f]);
    }
  }
  return { paths, byBasename, bySuffix };
}

/** Resolve a mention to a real repo path, or null when it is too ambiguous to claim. */
function resolveMention(raw: string, index: SourceIndex): string | null {
  let m = raw.trim().replace(/^\.\//, '').replace(/^\/+/, '');
  while (m.startsWith('../')) m = m.slice(3);
  if (m === '' || m.startsWith('http')) return null;
  if (index.paths.has(m)) return m;

  // Docs commonly cite `./scan.js` where the source is `src/core/scan.ts`.
  const swapped = m.replace(/\.js$/, '.ts').replace(/\.jsx$/, '.tsx');
  if (index.paths.has(swapped)) return swapped;

  for (const candidate of [m, swapped]) {
    const bySuffix = index.bySuffix.get(candidate);
    if (bySuffix && bySuffix.length === 1 && bySuffix[0]) return bySuffix[0];
    const base = candidate.split('/').pop() ?? candidate;
    const byBase = index.byBasename.get(base);
    if (byBase && byBase.length === 1 && byBase[0] && candidate.indexOf('/') === -1) return byBase[0];
  }
  return null;
}

/**
 * Mine the doc body for file references and collapse them into globs.
 * Only references that resolve to files actually present in the repo survive —
 * an inferred glob that matches nothing would immediately read as `orphaned`.
 */
export function inferDescribes(
  doc: DocRecord,
  index: SourceIndex,
): { globs: string[]; evidence: string[]; why: string } {
  const mentions = new Set<string>();
  const text = doc.body;

  for (const re of [PATHISH, IMPORTISH, BARE_FILE]) {
    re.lastIndex = 0;
    let match = re.exec(text);
    while (match !== null) {
      const captured = match[1];
      if (captured) mentions.add(captured);
      match = re.exec(text);
    }
  }

  const resolved = new Set<string>();
  for (const m of mentions) {
    const r = resolveMention(m, index);
    if (r) resolved.add(r);
  }
  const evidence = [...resolved].sort();
  if (evidence.length === 0) {
    return { globs: [], evidence, why: 'no resolvable source-file references in the body' };
  }

  // Collapse: a directory cited 3+ times becomes a `dir/**` glob.
  const byDir = new Map<string, string[]>();
  for (const f of evidence) {
    const dir = dirname(f);
    const list = byDir.get(dir);
    if (list) list.push(f);
    else byDir.set(dir, [f]);
  }

  const globs: string[] = [];
  const dirs = [...byDir.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [dir, files] of dirs) {
    if (files.length >= 3 && dir !== '.') globs.push(`${dir}/**`);
    else for (const f of files) globs.push(f);
  }

  const capped = globs.slice(0, 6);
  return {
    globs: capped,
    evidence,
    why: `${evidence.length} file reference${evidence.length === 1 ? '' : 's'} found in the body resolved to real repo paths`,
  };
}

/* ------------------------------------------------------------------ */
/* proposal + rendering                                                */
/* ------------------------------------------------------------------ */

export function proposeFor(doc: DocRecord, index: SourceIndex, taken: Set<string>): Proposal {
  const id = inferId(doc.path, taken);
  const kind = inferKind(doc);
  const describes = inferDescribes(doc, index);

  const frontmatter: Partial<KontextFrontmatter> = {
    kontext: KONTEXT_SPEC_VERSION,
    id,
    kind: kind.kind,
  };
  if (describes.globs.length > 0) frontmatter.describes = describes.globs;
  if (kind.kind === 'handoff') frontmatter.ttlDays = 7;

  const confidence: Proposal['confidence'] =
    describes.globs.length === 0 ? 'low' : describes.evidence.length >= 3 ? 'high' : 'medium';

  return {
    path: doc.path,
    frontmatter,
    notes: {
      id: `from the filename`,
      kind: kind.why,
      describes: describes.why,
    },
    evidence: describes.evidence,
    confidence,
  };
}

/** Build the frontmatter block, with the review comment injected inside it. */
export function renderFrontmatterBlock(p: Proposal, rawBody: string): string {
  const serialized = serializeFrontmatter(p.frontmatter, rawBody);
  const nl = serialized.indexOf('\n');
  if (nl === -1 || !serialized.startsWith('---')) {
    // Defensive: if the layer below changes shape, still emit something valid.
    return serialized;
  }
  const comment = [
    `# ${REVIEW_COMMENT}`,
    `# id: ${p.notes['id']}`,
    `# kind: ${p.notes['kind']}`,
    `# describes: ${p.notes['describes']}`,
  ].join('\n');
  return `${serialized.slice(0, nl + 1)}${comment}\n${serialized.slice(nl + 1)}`;
}

function previewLines(p: Proposal, rawBody: string, width: number): string[] {
  const block = renderFrontmatterBlock(p, rawBody);
  const bodyStart = block.indexOf(rawBody);
  const fmOnly = bodyStart === -1 ? block : block.slice(0, bodyStart);
  const added = fmOnly.replace(/\n+$/, '').split('\n');
  const context = rawBody.split('\n').slice(0, 2);
  // A preview, not the artefact: truncating keeps the layout intact, and the
  // file that actually gets written carries the full text.
  const fit = (l: string) => truncate(l, Math.max(8, width - 4));
  return [
    ...added.map((l) => c.green(`  + ${fit(l)}`)),
    ...context.map((l) => c.dim(`    ${fit(l)}`)),
    c.dim('    …'),
  ];
}

const CONF_COLOUR: Record<Proposal['confidence'], (s: string) => string> = {
  high: c.green,
  medium: c.yellow,
  low: c.grey,
};

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

  const dryRun = getBool(args, 'dry-run');
  const write = getBool(args, 'yes') && !dryRun;
  const asJson = getBool(args, 'json');
  const width = terminalWidth();

  const root = findRepoRoot(process.cwd());
  const config = loadConfig(root);
  const docs = await scanDocs(root, config);

  // ---- Scope guard -------------------------------------------------------
  // `init` rewrites files. If the root resolved wider than the user meant --
  // typically because this folder has no `.git` and an ancestor does -- then
  // "add frontmatter to every doc" means every markdown file they own. Refuse
  // loudly rather than being catastrophically obedient.
  const scopeProblems: string[] = [];
  if (isHomeDirRoot(root)) {
    scopeProblems.push(
      `the root resolved to your home directory (${root}) — this folder has no .git of its own, so kontext walked up until it found one`,
    );
  }
  if (docs.length > WIDE_SCOPE_DOC_COUNT) {
    scopeProblems.push(
      `${docs.length} documents is far more than one project usually holds — the root is probably wider than you meant`,
    );
  }
  if (scopeProblems.length > 0 && !write) {
    // Previewing is harmless, so let it through — but say plainly that the
    // scope looks wrong, before the user reads 3,000 proposals as normal.
    err(c.yellow(`warning: this root looks wider than you probably meant — ${root}`));
    for (const p of scopeProblems) err(c.dim(`  · ${p}`));
    err('');
  } else if (scopeProblems.length > 0 && !getBool(args, 'force')) {
    err(c.red(`refusing to write: ${root}`));
    for (const p of scopeProblems) err(c.dim(`  · ${p}`));
    err('');
    err('this would touch every markdown file under that root. options:');
    err(c.dim('  · run `git init` in the project folder you actually meant, then retry'));
    err(c.dim('  · cd into a folder that has its own .git'));
    err(c.dim('  · pass --force if this really is what you want'));
    return 2;
  }

  let tracked: string[] = [];
  try {
    tracked = listTrackedFiles(root);
  } catch {
    tracked = [];
  }
  const index = buildSourceIndex(tracked);

  const taken = new Set<string>();
  for (const d of docs) {
    const id = d.frontmatter.id;
    if (typeof id === 'string' && id) taken.add(id);
  }

  const needing = docs.filter((d) => !d.hasFrontmatter);
  const existing = docs.filter((d) => d.hasFrontmatter);

  const proposals: Proposal[] = [];
  for (const doc of needing) {
    const p = proposeFor(doc, index, taken);
    taken.add(p.frontmatter.id ?? '');
    proposals.push(p);
  }

  const configPath = join(root, 'kontext.config.json');
  const configExists = existsSync(configPath);

  if (asJson) {
    json({
      root,
      wrote: write,
      dryRun,
      configPath,
      configExists,
      alreadyKontextAware: existing.map((d) => ({
        path: d.path,
        id: d.frontmatter.id ?? null,
        hasDescribes: Array.isArray(d.frontmatter.describes) && d.frontmatter.describes.length > 0,
      })),
      proposals: proposals.map((p) => ({
        path: p.path,
        confidence: p.confidence,
        frontmatter: p.frontmatter,
        notes: p.notes,
        evidence: p.evidence,
      })),
    });
    if (!write) return 0;
    // fall through to writing below is not possible after json(); do the writes now.
  }

  if (!asJson) {
    out();
    out(banner('kontext init', [], root, width));
    out();
    if (proposals.length === 0) {
      out(c.dim(`all ${docs.length} doc(s) already carry frontmatter — nothing to infer`));
    } else {
      outWrap(
        `${proposals.length} doc(s) lack frontmatter${SEP}${existing.length} already kontext-aware${SEP}${index.paths.size} source files indexed`,
        width,
        c.dim,
      );
      out();
      outWrap('every field below is a GUESS. review before you trust it.', width, c.yellow);
      out();
    }

    for (const p of proposals) {
      const raw = readFileSync(join(root, p.path), 'utf8');
      out(`${c.bold(truncate(p.path, width - 14))}  ${CONF_COLOUR[p.confidence](p.confidence)}`);
      for (const line of previewLines(p, raw, width)) out(line);
      if (p.evidence.length > 0) {
        const shown = p.evidence.slice(0, 5).join(', ');
        out(c.dim(`    evidence: ${truncate(shown, width - 16)}${p.evidence.length > 5 ? ` (+${p.evidence.length - 5})` : ''}`));
      }
      out();
    }

    if (existing.length > 0) {
      const missingDescribes = existing.filter(
        (d) => !Array.isArray(d.frontmatter.describes) || d.frontmatter.describes.length === 0,
      );
      if (missingDescribes.length > 0) {
        outWrap(
          `${missingDescribes.length} doc(s) already have frontmatter but no \`describes\` — kontext cannot prove anything about them:`,
          width,
          c.dim,
        );
        for (const d of missingDescribes.slice(0, 10)) out(c.dim(`    ${truncate(d.path, width - 6)}`));
        if (missingDescribes.length > 10) out(c.dim(`    (+${missingDescribes.length - 10} more)`));
        out();
      }
    }

    if (configExists) outWrap('kontext.config.json already exists — left alone', width, c.dim);
    else out(c.green('  + kontext.config.json (starter)'));
    out();
  }

  if (!write) {
    if (!asJson) {
      out(c.bold(dryRun ? 'dry run — nothing written.' : 'nothing written.'));
      outWrap(
        're-run with --yes to apply. bodies are preserved byte-for-byte; only frontmatter is prepended.',
        width,
        c.dim,
      );
      out();
    }
    return 0;
  }

  let written = 0;
  for (const p of proposals) {
    const abs = join(root, p.path);
    const raw = readFileSync(abs, 'utf8');
    const next = renderFrontmatterBlock(p, raw);
    writeFileSync(abs, next, 'utf8');
    written += 1;
  }

  if (!configExists) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
  }

  if (!asJson) {
    outWrap(
      `wrote frontmatter to ${written} doc(s)${configExists ? '' : ' and created kontext.config.json'}`,
      width,
      c.green,
    );
    outWrap('next: `kontext check --fix-hints` to see what the new claims prove', width, c.dim);
    out();
  }
  return 0;
}

export const initCommand: CommandDef = {
  name: 'init',
  summary: 'Infer frontmatter for docs that have none, and write a starter config.',
  usage: 'kontext init [--dry-run] [--yes] [--json]',
  details: [
    'Scans every managed markdown file, and for each one lacking frontmatter proposes',
    'an id (from the filename), a kind (from path and heading shape) and candidate',
    '`describes` globs mined from the source paths and imports the body already cites.',
    '',
    'Only references that resolve to files actually tracked in the repo become globs,',
    'so init will not hand you a claim that is orphaned on arrival.',
    '',
    'Prints a diff preview and writes NOTHING without --yes. When it does write, the',
    'existing body is preserved byte-for-byte and every inferred field is flagged in a',
    'YAML comment as needing review.',
  ].join('\n'),
  flags,
  run,
};

export default initCommand;
