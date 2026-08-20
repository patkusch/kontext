#!/usr/bin/env node
/**
 * kontext — CLI entry point.
 *
 * Exit codes are part of the contract, because `check` is meant to sit in CI:
 *   0  success
 *   1  the command's own failure condition (check gate tripped, doctor blocker)
 *   2  usage error (bad flag, unknown command, missing argument)
 *   3  unexpected error — set KONTEXT_DEBUG=1 to see the stack
 */

import { readFileSync } from 'node:fs';
import { checkCommand } from './commands/check.js';
import { mapCommand } from './commands/map.js';
import { packCommand } from './commands/pack.js';
import { initCommand } from './commands/init.js';
import { handoffCommand } from './commands/handoff.js';
import { doctorCommand } from './commands/doctor.js';
import { mcpCommand } from './commands/mcp.js';
import { type CommandDef, formatFlags, suggest } from './util/args.js';
import { SEP, c, err, out, terminalWidth } from './util/render.js';

const COMMANDS: CommandDef[] = [
  checkCommand,
  mapCommand,
  packCommand,
  initCommand,
  handoffCommand,
  doctorCommand,
  mcpCommand,
];

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_ERROR = 3;

function version(): string {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const raw = readFileSync(new URL(rel, import.meta.url), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const v = (parsed as Record<string, unknown>)['version'];
        if (typeof v === 'string') return v;
      }
    } catch {
      // try the next candidate
    }
  }
  return '0.0.0';
}

function topHelp(): void {
  const width = terminalWidth();
  out();
  out(`${c.bold('kontext')} ${c.dim(`v${version()}`)}`);
  out(c.dim('Give your markdown a lifecycle. Prove which docs are stale, pack fresh context.'));
  out();
  out(c.bold('usage'));
  out('  kontext <command> [options]');
  out();
  out(c.bold('commands'));
  const pad = COMMANDS.reduce((m, cmd) => Math.max(m, cmd.name.length), 0);
  for (const cmd of COMMANDS) {
    const summary = cmd.summary.length > width - pad - 6 ? `${cmd.summary.slice(0, width - pad - 9)}...` : cmd.summary;
    out(`  ${c.cyan(cmd.name.padEnd(pad))}  ${summary}`);
  }
  out();
  out(c.bold('global'));
  out(`  ${'-h, --help'.padEnd(pad + 12)}  Show help. Works per command too: kontext check --help`);
  out(`  ${'-v, --version'.padEnd(pad + 12)}  Print the version.`);
  out();
  out(c.dim(`every command supports --json${SEP}colour follows NO_COLOR and TTY detection`));
  out();
  out(c.dim('start with:  kontext doctor'));
  out();
}

function commandHelp(cmd: CommandDef): void {
  out();
  out(`${c.bold(`kontext ${cmd.name}`)} ${c.dim('—')} ${cmd.summary}`);
  out();
  out(c.bold('usage'));
  out(`  ${cmd.usage}`);
  out();
  if (cmd.details) {
    out(c.bold('description'));
    for (const line of cmd.details.split('\n')) out(line === '' ? '' : `  ${line}`);
    out();
  }
  out(c.bold('options'));
  for (const line of formatFlags(cmd.flags)) out(line);
  out();
}

function isHelpFlag(token: string | undefined): boolean {
  return token === '--help' || token === '-h' || token === 'help';
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    const target = first === 'help' || first === '--help' || first === '-h' ? argv[1] : undefined;
    if (target !== undefined) {
      const cmd = COMMANDS.find((x) => x.name === target);
      if (cmd) {
        commandHelp(cmd);
        return EXIT_OK;
      }
    }
    topHelp();
    return first === undefined ? EXIT_OK : EXIT_OK;
  }

  if (first === '--version' || first === '-v' || first === 'version') {
    out(version());
    return EXIT_OK;
  }

  const cmd = COMMANDS.find((x) => x.name === first);
  if (!cmd) {
    err(c.red(`unknown command: ${first}`));
    const hint = suggest(
      first.replace(/^-+/, ''),
      COMMANDS.map((x) => x.name),
    );
    if (hint) err(`did you mean ${c.cyan(hint)}?`);
    err(c.dim(`run \`kontext --help\` to see all commands`));
    return EXIT_USAGE;
  }

  const rest = argv.slice(1);
  if (rest.some((t) => isHelpFlag(t) && t !== 'help')) {
    commandHelp(cmd);
    return EXIT_OK;
  }

  return cmd.run(rest);
}

const debug = process.env['KONTEXT_DEBUG'] === '1';

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (debug) {
      console.error(error);
    } else {
      const message =
        error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error';
      err(c.red(`kontext: ${message}`));
      err(c.dim('set KONTEXT_DEBUG=1 for the full stack trace'));
    }
    process.exitCode = EXIT_ERROR;
  });
