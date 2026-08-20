/**
 * Terminal presentation: colour, markers, width-aware layout.
 *
 * No chalk, no cli-table. The rules here are simple and non-negotiable:
 *   - respect NO_COLOR
 *   - drop colour and Unicode when stdout is not a TTY (pipes, CI logs, agents)
 *   - never emit a line wider than the terminal
 *   - truncate paths from the left so the filename always survives
 */

import type { Freshness } from '../types.js';

const env = process.env;

function detectRich(): boolean {
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false;
  if (env['KONTEXT_FORCE_COLOR'] === '1' || env['FORCE_COLOR'] === '1') return true;
  if (env['TERM'] === 'dumb') return false;
  return process.stdout.isTTY === true;
}

/** True when we may use colour and Unicode. Computed once at load. */
export const RICH: boolean = detectRich();

export function terminalWidth(): number {
  const cols = process.stdout.columns;
  if (typeof cols === 'number' && cols >= 40) return Math.min(cols, 200);
  // Piped output reports no columns; honour COLUMNS so CI logs and `script`
  // wrappers can still be told how wide they are.
  const fromEnv = Number(env['COLUMNS']);
  if (Number.isFinite(fromEnv) && fromEnv >= 40) return Math.min(fromEnv, 200);
  return 80;
}

type Code = [number, number];

const CODES = {
  reset: [0, 0] as Code,
  bold: [1, 22] as Code,
  dim: [2, 22] as Code,
  italic: [3, 23] as Code,
  underline: [4, 24] as Code,
  red: [31, 39] as Code,
  green: [32, 39] as Code,
  yellow: [33, 39] as Code,
  blue: [34, 39] as Code,
  magenta: [35, 39] as Code,
  cyan: [36, 39] as Code,
  white: [37, 39] as Code,
  grey: [90, 39] as Code,
};

function wrap(code: Code, s: string): string {
  if (!RICH || s === '') return s;
  return `\u001b[${code[0]}m${s}\u001b[${code[1]}m`;
}

export const c = {
  bold: (s: string) => wrap(CODES.bold, s),
  dim: (s: string) => wrap(CODES.dim, s),
  italic: (s: string) => wrap(CODES.italic, s),
  underline: (s: string) => wrap(CODES.underline, s),
  red: (s: string) => wrap(CODES.red, s),
  green: (s: string) => wrap(CODES.green, s),
  yellow: (s: string) => wrap(CODES.yellow, s),
  blue: (s: string) => wrap(CODES.blue, s),
  magenta: (s: string) => wrap(CODES.magenta, s),
  cyan: (s: string) => wrap(CODES.cyan, s),
  grey: (s: string) => wrap(CODES.grey, s),
};

const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function isWide(cp: number): boolean {
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  );
}

/** Printable columns a string occupies, ignoring ANSI and counting CJK as 2. */
export function displayWidth(s: string): number {
  const plain = stripAnsi(s);
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue; // ZWJ / variation selectors
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

/** Pad to `width` display columns (ANSI-safe). */
export function padEnd(s: string, width: number): string {
  const diff = width - displayWidth(s);
  return diff > 0 ? s + ' '.repeat(diff) : s;
}

export function padStart(s: string, width: number): string {
  const diff = width - displayWidth(s);
  return diff > 0 ? ' '.repeat(diff) + s : s;
}

const ELLIPSIS = RICH ? '…' : '...';

/** Truncate on the right, for prose. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  if (displayWidth(s) <= max) return s;
  const plain = stripAnsi(s);
  const keep = Math.max(0, max - displayWidth(ELLIPSIS));
  let out = '';
  let w = 0;
  for (const ch of plain) {
    const cw = displayWidth(ch);
    if (w + cw > keep) break;
    out += ch;
    w += cw;
  }
  return out + ELLIPSIS;
}

/**
 * Truncate a path from the LEFT so the filename stays visible:
 * `docs/very/deep/nested/thing.md` -> `…/nested/thing.md`
 */
export function truncatePath(p: string, max: number): string {
  if (max <= 0) return '';
  if (displayWidth(p) <= max) return p;
  // Budget for the ellipsis AND the separator slash it introduces.
  const keep = Math.max(1, max - displayWidth(ELLIPSIS) - 1);
  const segments = p.split('/');
  const last = segments[segments.length - 1] ?? p;

  if (displayWidth(last) > keep) {
    // Even the filename does not fit; chop into it, and drop the slash so the
    // result never reads as a real path segment.
    const plain = stripAnsi(last);
    const room = Math.max(1, max - displayWidth(ELLIPSIS));
    return ELLIPSIS + plain.slice(Math.max(0, plain.length - room));
  }

  let tail = last;
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    const candidate = `${segments[i]}/${tail}`;
    if (displayWidth(candidate) > keep) break;
    tail = candidate;
  }
  return `${ELLIPSIS}/${tail}`;
}

/* ------------------------------------------------------------------ */
/* Freshness vocabulary                                                */
/* ------------------------------------------------------------------ */

const UNICODE_MARKS: Record<Freshness, string> = {
  fresh: '●',
  drifting: '◐',
  stale: '○',
  expired: '⊗',
  superseded: '⇥',
  orphaned: '⊘',
  unverified: '·',
};

const ASCII_MARKS: Record<Freshness, string> = {
  fresh: '+',
  drifting: '~',
  stale: 'o',
  expired: 'x',
  superseded: '>',
  orphaned: '!',
  unverified: '.',
};

type Painter = (s: string) => string;

const PAINT: Record<Freshness, Painter> = {
  fresh: c.green,
  drifting: c.yellow,
  stale: c.red,
  expired: c.red,
  superseded: c.magenta,
  orphaned: c.red,
  unverified: c.grey,
};

/** The bare marker glyph for a verdict, uncoloured. */
export function markGlyph(f: Freshness): string {
  return (RICH ? UNICODE_MARKS : ASCII_MARKS)[f];
}

/** Coloured marker glyph. */
export function mark(f: Freshness): string {
  return PAINT[f](markGlyph(f));
}

/** Colourise arbitrary text in a verdict's colour. */
export function paint(f: Freshness, s: string): string {
  return PAINT[f](s);
}

/** Coloured verdict word, e.g. a red `stale`. */
export function label(f: Freshness): string {
  return PAINT[f](f);
}

/** The legend printed under `check` / `map`, wrapped to fit. */
export function legendLines(width: number): string[] {
  const order: Freshness[] = ['fresh', 'drifting', 'stale', 'expired', 'orphaned', 'superseded', 'unverified'];
  const parts = order.map((f) => c.dim(`${markGlyph(f)} ${f}`));
  return joinWrapped(parts, '  ', width);
}

/* ------------------------------------------------------------------ */
/* Small layout primitives                                             */
/* ------------------------------------------------------------------ */

export const SEP = RICH ? ' · ' : ' | ';
export const ARROW = RICH ? '↳' : '->';
export const BULLET = RICH ? '·' : '-';
export const TREE_MID = RICH ? '├─' : '|-';
export const TREE_END = RICH ? '└─' : '`-';
export const TREE_BAR = RICH ? '│ ' : '|  ';

export interface Column {
  align?: 'left' | 'right';
  /** Hard cap; the column shrinks to fit but never grows past this. */
  max?: number;
  /** When space is short, columns with higher flex give up width first. */
  flex?: boolean;
  /** Truncate from the left (for paths). */
  path?: boolean;
}

/**
 * Render aligned rows. Widths are computed on *display* width so ANSI colour
 * never breaks alignment. The flex column absorbs whatever space is left.
 */
export function table(rows: string[][], cols: Column[], gap = 2, width = terminalWidth()): string[] {
  if (rows.length === 0) return [];
  const count = cols.length;
  const natural: number[] = [];
  for (let i = 0; i < count; i += 1) {
    let w = 0;
    for (const row of rows) w = Math.max(w, displayWidth(row[i] ?? ''));
    const max = cols[i]?.max;
    natural.push(max ? Math.min(w, max) : w);
  }

  const gaps = gap * Math.max(0, count - 1);
  const total = natural.reduce((a, b) => a + b, 0) + gaps;
  if (total > width) {
    const flexIdx = cols.map((col, i) => (col.flex ? i : -1)).filter((i) => i >= 0);
    let excess = total - width;
    const targets = flexIdx.length > 0 ? flexIdx : natural.map((_, i) => i);
    for (const i of targets) {
      if (excess <= 0) break;
      const cur = natural[i] ?? 0;
      const min = 8;
      const shrink = Math.min(excess, Math.max(0, cur - min));
      natural[i] = cur - shrink;
      excess -= shrink;
    }
  }

  const out: string[] = [];
  for (const row of rows) {
    const cells: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const col = cols[i] ?? {};
      const w = natural[i] ?? 0;
      let cell = row[i] ?? '';
      if (displayWidth(cell) > w) cell = col.path ? truncatePath(cell, w) : truncate(cell, w);
      cells.push(i === count - 1 && col.align !== 'right' ? cell : col.align === 'right' ? padStart(cell, w) : padEnd(cell, w));
    }
    out.push(cells.join(' '.repeat(gap)).replace(/\s+$/, ''));
  }
  return out;
}

/** A section heading with a rule, e.g. `── stale ──────────`. */
export function heading(text: string, width = terminalWidth()): string {
  const rule = RICH ? '─' : '-';
  const prefix = `${rule.repeat(2)} ${text} `;
  const fill = Math.max(0, width - displayWidth(prefix));
  return c.dim(prefix + rule.repeat(fill));
}

/**
 * The command banner: `kontext check · 12 docs · /path/to/repo`, with the repo
 * path truncated from the left so the line never exceeds the terminal.
 */
export function banner(title: string, bits: string[], root: string, width = terminalWidth()): string {
  const head = [c.bold(title), ...bits].join(SEP);
  const room = width - displayWidth(head) - displayWidth(SEP);
  if (room < 12) return truncate(head, width);
  return `${head}${SEP}${c.dim(truncatePath(root, room))}`;
}

/**
 * Wrap prose to a width. Words longer than the width (long file paths, mostly)
 * are hard-broken rather than allowed to overflow.
 */
export function wrapText(text: string, width: number, indent = ''): string[] {
  const room = Math.max(4, width - displayWidth(indent));
  const words: string[] = [];
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    let word = raw;
    while (displayWidth(word) > room) {
      let head = '';
      for (const ch of word) {
        if (displayWidth(head) + displayWidth(ch) > room) break;
        head += ch;
      }
      if (head === '') break;
      words.push(head);
      word = word.slice(head.length);
    }
    if (word !== '') words.push(word);
  }

  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (displayWidth(candidate) > room && line !== '') {
      lines.push(indent + line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== '') lines.push(indent + line);
  return lines;
}

/**
 * Greedily pack already-coloured fragments into lines. Used for the legend and
 * the verdict summary, where each fragment carries its own ANSI and so cannot
 * survive being re-wrapped as plain text.
 */
export function joinWrapped(parts: string[], sep: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const part of parts) {
    const candidate = line === '' ? part : `${line}${sep}${part}`;
    if (displayWidth(candidate) > width && line !== '') {
      lines.push(line);
      line = part;
    } else {
      line = candidate;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/** `12345` -> `12.3k`. Token counts get long fast. */
export function humanTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n / 1000)}k`;
}

/** A compact proportional bar, used in the map heatmap. */
export function bar(fraction: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  const full = RICH ? '█' : '#';
  const empty = RICH ? '░' : '.';
  return full.repeat(filled) + empty.repeat(width - filled);
}

/* ------------------------------------------------------------------ */
/* Streams                                                             */
/* ------------------------------------------------------------------ */

export function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function err(line = ''): void {
  process.stderr.write(`${line}\n`);
}

/** Print prose wrapped to the terminal, optionally painting each line. */
export function outWrap(text: string, width = terminalWidth(), paintFn?: (s: string) => string, indent = ''): void {
  for (const line of wrapText(text, width, indent)) out(paintFn ? paintFn(line) : line);
}

/** As `outWrap`, but to stderr. */
export function errWrap(text: string, width = terminalWidth(), paintFn?: (s: string) => string, indent = ''): void {
  for (const line of wrapText(text, width, indent)) err(paintFn ? paintFn(line) : line);
}

export function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
