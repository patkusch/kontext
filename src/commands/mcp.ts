/**
 * `kontext mcp` — run the MCP server over stdio.
 *
 * This is the same server as `dist/mcp/server.js`; exposing it as a subcommand
 * means users can wire it up with `npx kontext mcp` instead of hardcoding a
 * path into `dist/`, which breaks the moment the package is installed
 * somewhere else.
 */

import { type CommandDef } from '../util/args.js';

export const mcpCommand: CommandDef = {
  name: 'mcp',
  summary: 'Run the MCP server so agents can query context directly',
  usage: 'kontext mcp',
  details: `Speaks the Model Context Protocol over stdio. Point an MCP client at it:

  claude mcp add kontext -- npx -y kontext mcp

The repo root is taken from KONTEXT_ROOT if set, otherwise discovered from the
working directory. Clients whose working directory is not your repo (Claude
Desktop, for one) must set KONTEXT_ROOT explicitly.

stdout is the protocol channel and carries JSON only; all diagnostics go to
stderr. This command never returns — stop it by closing the transport.`,
  flags: {},
  async run(): Promise<number> {
    // Importing the module starts the server and connects the stdio transport.
    await import('../mcp/server.js');
    // The server owns the process from here. Resolving would let the CLI call
    // process.exit() and kill the transport mid-session.
    return new Promise<number>(() => {});
  },
};
