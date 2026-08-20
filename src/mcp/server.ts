#!/usr/bin/env node
/**
 * kontext MCP server — a freshness-aware context API for coding agents.
 *
 * Speaks MCP over stdio. Any agent that can call tools (Claude Code, Claude
 * Desktop, Cursor) can ask this server for the documentation that bears on a
 * task and get back a ranked, budgeted bundle in which every section carries a
 * staleness verdict proven from git history — and in which nothing is ever
 * dropped without being named.
 *
 * stdout belongs to the MCP protocol. Every diagnostic in this process goes to
 * stderr, and `console.log` is rebound to stderr defensively, because a single
 * stray stdout write corrupts the JSON-RPC stream and kills the connection.
 */

import * as path from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';

import { findRepoRoot } from '../core/config.js';
import { listTools, runTool } from './tools.js';

const SERVER_NAME = 'kontext';
const SERVER_VERSION = '0.1.0';

/* ------------------------------------------------------------------ */
/* stdout hygiene                                                      */
/* ------------------------------------------------------------------ */

function log(...parts: unknown[]): void {
  process.stderr.write(`[kontext-mcp] ${parts.map((p) => (typeof p === 'string' ? p : String(p))).join(' ')}\n`);
}

/**
 * Anything below us that calls console.log would silently corrupt the protocol
 * stream. Rebind the stdout-bound console methods to stderr before we connect.
 */
function protectStdout(): void {
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(`${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.dir = toStderr;
}

/* ------------------------------------------------------------------ */
/* Root resolution                                                     */
/* ------------------------------------------------------------------ */

type RootResolution = { ok: true; root: string } | { ok: false; message: string };

let resolvedRoot: RootResolution | null = null;

function resolveRoot(): RootResolution {
  if (resolvedRoot !== null) return resolvedRoot;

  const override = process.env['KONTEXT_ROOT'];
  if (override !== undefined && override.trim() !== '') {
    resolvedRoot = { ok: true, root: path.resolve(override.trim()) };
    return resolvedRoot;
  }

  try {
    resolvedRoot = { ok: true, root: findRepoRoot(process.cwd()) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    resolvedRoot = {
      ok: false,
      message: [
        `Not a git repo (searched upward from ${process.cwd()}): ${detail}`,
        'kontext needs git history to prove staleness — without commits, a doc\'s freshness is unknowable.',
        'Fix: start the server with its working directory inside a git repository, or set KONTEXT_ROOT to one.',
      ].join('\n'),
    };
  }
  return resolvedRoot;
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

const INSTRUCTIONS = [
  'kontext gives this repo\'s markdown a lifecycle: each doc declares which source files it describes, and git',
  'proves whether that code has moved since the doc was last updated. Every answer from this server carries a',
  'freshness verdict backed by commit evidence.',
  '',
  'Typical flow: call kontext_pack with the task you are about to do to get ranked, budgeted context; call',
  'kontext_search for cheap discovery; call kontext_read when you want one document in full (it comes with its',
  'trust verdict attached); call kontext_freshness before acting on a doc you are unsure about; call',
  'kontext_conflicts when two docs seem to disagree. At the start of a session call kontext_handoff_read to pick',
  'up the previous session\'s working state, and before you run out of context call kontext_handoff_write to',
  'leave yours.',
  '',
  'Material withheld for staleness is always listed explicitly — if a section says nothing was withheld, nothing was.',
].join('\n');

function notARepoResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `ERROR: kontext could not resolve a repository root.\n${message}` }],
    isError: true,
  };
}

async function main(): Promise<void> {
  protectStdout();

  const root = resolveRoot();
  if (root.ok) {
    log(`root: ${root.root}`);
    log(`source: ${process.env['KONTEXT_ROOT'] !== undefined ? 'KONTEXT_ROOT' : 'git repo discovery from cwd'}`);
  } else {
    log('WARNING: no repo root resolved. Tools will return actionable errors until this is fixed.');
    for (const line of root.message.split('\n')) log(line);
  }

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, (): ListToolsResult => {
    return { tools: listTools() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const resolution = resolveRoot();
    if (!resolution.ok) return notARepoResult(resolution.message);

    const name = request.params.name;
    const args: Record<string, unknown> =
      request.params.arguments !== undefined && request.params.arguments !== null
        ? (request.params.arguments as Record<string, unknown>)
        : {};

    const started = Date.now();
    const result = await runTool(name, args, { root: resolution.root });
    log(`${name} -> ${result.isError === true ? 'error' : 'ok'} in ${Date.now() - started}ms`);
    return result;
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready — ${listTools().length} tools over stdio`);

  const shutdown = (signal: string): void => {
    log(`received ${signal}, closing`);
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Degrade, do not crash: a dead MCP server is worse than a degraded one.
process.on('uncaughtException', (err: Error) => {
  log(`uncaught exception: ${err.stack ?? err.message}`);
});
process.on('unhandledRejection', (reason: unknown) => {
  log(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
