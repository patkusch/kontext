/**
 * A tiny, dependency-free argument parser.
 *
 * Deliberately small: it handles the shapes kontext's CLI actually uses
 * (`--flag`, `--no-flag`, `--flag value`, `--flag=value`, `-f`, repeated
 * flags, and a `--` terminator) and nothing more. Zero npm dependencies is a
 * hard constraint of this project.
 */

export type FlagType = 'boolean' | 'string' | 'number' | 'list';

export interface FlagSpec {
  type: FlagType;
  /** Single-character alias, without the dash. */
  alias?: string;
  /** Shown in `--help`. */
  description: string;
  /** Value placeholder shown in help, e.g. `<n>`. */
  placeholder?: string;
  /** Default applied when the flag is absent. */
  default?: string | number | boolean | string[];
}

export type FlagSpecs = Record<string, FlagSpec>;

export type FlagValue = string | number | boolean | string[] | undefined;

export interface ParsedArgs {
  /** Everything that was not a flag or a flag value. */
  positionals: string[];
  flags: Record<string, FlagValue>;
  /** Flags that matched no spec. Callers decide whether that is fatal. */
  unknown: string[];
  /** Parse problems that are definitely fatal (e.g. `--budget abc`). */
  errors: string[];
}

/** A CLI subcommand, as consumed by `cli.ts`. */
export interface CommandDef {
  name: string;
  summary: string;
  /** e.g. `kontext pack <task...> [options]` */
  usage: string;
  /** Longer prose shown under `kontext <cmd> --help`. */
  details?: string;
  flags: FlagSpecs;
  /** Returns the process exit code. */
  run(argv: string[]): Promise<number>;
}

const GLOBAL_FLAGS: FlagSpecs = {
  help: { type: 'boolean', alias: 'h', description: 'Show help for this command.' },
};

function coerce(spec: FlagSpec, raw: string, name: string, errors: string[]): FlagValue {
  if (spec.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      errors.push(`--${name} expects a number, got ${JSON.stringify(raw)}`);
      return undefined;
    }
    return n;
  }
  return raw;
}

/**
 * Parse `argv` (already stripped of node/script/command) against `specs`.
 * Unknown flags are collected rather than thrown so the caller can offer a
 * suggestion instead of a bare failure.
 */
export function parseArgs(argv: string[], specs: FlagSpecs): ParsedArgs {
  const all: FlagSpecs = { ...GLOBAL_FLAGS, ...specs };
  const byAlias = new Map<string, string>();
  for (const [name, spec] of Object.entries(all)) {
    if (spec.alias) byAlias.set(spec.alias, name);
  }

  const positionals: string[] = [];
  const flags: Record<string, FlagValue> = {};
  const unknown: string[] = [];
  const errors: string[] = [];

  for (const [name, spec] of Object.entries(all)) {
    if (spec.default !== undefined) flags[name] = spec.default;
    else if (spec.type === 'boolean') flags[name] = false;
    else if (spec.type === 'list') flags[name] = [];
  }

  let i = 0;
  let terminated = false;

  const setValue = (name: string, spec: FlagSpec, raw: string): void => {
    if (spec.type === 'list') {
      const prev = flags[name];
      const arr = Array.isArray(prev) ? prev.slice() : [];
      for (const part of raw.split(',')) {
        const trimmed = part.trim();
        if (trimmed) arr.push(trimmed);
      }
      flags[name] = arr;
      return;
    }
    const value = coerce(spec, raw, name, errors);
    if (value !== undefined) flags[name] = value;
  };

  while (i < argv.length) {
    const token = argv[i];
    i += 1;
    if (token === undefined) continue;

    if (terminated) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      terminated = true;
      continue;
    }

    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      let name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const inline = eq === -1 ? undefined : token.slice(eq + 1);
      let negated = false;

      if (!all[name] && name.startsWith('no-') && all[name.slice(3)]?.type === 'boolean') {
        name = name.slice(3);
        negated = true;
      }

      const spec = all[name];
      if (!spec) {
        unknown.push(token);
        continue;
      }
      if (spec.type === 'boolean') {
        if (inline !== undefined) {
          flags[name] = inline !== 'false' && inline !== '0';
        } else {
          flags[name] = !negated;
        }
        continue;
      }
      if (inline !== undefined) {
        setValue(name, spec, inline);
        continue;
      }
      const next = argv[i];
      if (next === undefined || (next.startsWith('-') && next !== '-' && Number.isNaN(Number(next)))) {
        errors.push(`--${name} expects a value`);
        continue;
      }
      i += 1;
      setValue(name, spec, next);
      continue;
    }

    if (token.startsWith('-') && token.length > 1 && token !== '-') {
      // Support bundled boolean shorts (-ab) and `-k value`.
      const chars = token.slice(1).split('');
      for (let c = 0; c < chars.length; c += 1) {
        const ch = chars[c];
        if (ch === undefined) continue;
        const name = byAlias.get(ch);
        const spec = name ? all[name] : undefined;
        if (!name || !spec) {
          unknown.push(`-${ch}`);
          continue;
        }
        if (spec.type === 'boolean') {
          flags[name] = true;
          continue;
        }
        const rest = chars.slice(c + 1).join('');
        if (rest) {
          setValue(name, spec, rest);
          c = chars.length;
          continue;
        }
        const next = argv[i];
        if (next === undefined) {
          errors.push(`-${ch} expects a value`);
          continue;
        }
        i += 1;
        setValue(name, spec, next);
      }
      continue;
    }

    positionals.push(token);
  }

  return { positionals, flags, unknown, errors };
}

/** Read a flag as a string, falling back when absent or of another type. */
export function getString(args: ParsedArgs, name: string, fallback?: string): string | undefined {
  const v = args.flags[name];
  return typeof v === 'string' ? v : fallback;
}

export function getNumber(args: ParsedArgs, name: string, fallback?: number): number | undefined {
  const v = args.flags[name];
  return typeof v === 'number' ? v : fallback;
}

export function getBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

export function getList(args: ParsedArgs, name: string): string[] {
  const v = args.flags[name];
  return Array.isArray(v) ? v : [];
}

/** Levenshtein distance, used for `did you mean` suggestions. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev: number[] = [];
  for (let j = 0; j <= b.length; j += 1) prev.push(j);
  for (let i = 1; i <= a.length; i += 1) {
    const curr: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr.push(Math.min(del, ins, sub));
    }
    prev = curr;
  }
  return prev[b.length] ?? 0;
}

/** Closest candidate within a sane distance, or undefined. */
export function suggest(input: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const d = editDistance(input.toLowerCase(), c.toLowerCase());
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  const threshold = Math.max(2, Math.floor(input.length / 2));
  return best !== undefined && bestScore <= threshold ? best : undefined;
}

/** Render a flag table for `--help`. */
export function formatFlags(specs: FlagSpecs): string[] {
  const merged: FlagSpecs = { ...specs, ...GLOBAL_FLAGS };
  const rows: [string, string][] = [];
  for (const [name, spec] of Object.entries(merged)) {
    const alias = spec.alias ? `-${spec.alias}, ` : '    ';
    const ph = spec.type === 'boolean' ? '' : ` ${spec.placeholder ?? `<${spec.type === 'list' ? 'list' : spec.type}>`}`;
    rows.push([`${alias}--${name}${ph}`, spec.description]);
  }
  const width = rows.reduce((m, r) => Math.max(m, r[0].length), 0);
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`);
}
