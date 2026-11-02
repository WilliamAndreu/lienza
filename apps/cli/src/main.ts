#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from '@figma-reader/server/mcp';
import { openDocument } from './document.js';
import { exportDocument } from './export.js';
import { startInteractive } from './interactive/repl.js';
import { pngInChildProcess, renderPng } from './png.js';
import { commandReferences, documentSummary, themeSection } from './references.js';

const usage = `Usage: lienza [file.fig]                         Interactive session (Tab completes, help lists commands)
       lienza <command> <file.fig> [options]       One query, for scripts and agents

Queries (JSON on stdout):
  status <file>                         Document name, parser, counts, and pages
  layers <file> [--id] [--depth 2]      Layer tree of the document, a page, or a node
  search <file> <query> [--limit 50]    Nodes whose name or type matches
  node <file> --id <id>                 Design properties, text, colors, and child layers
  context <file> --id <id> [--depth 1] [--limit 60]
                                        Implementation context with provenance
  theme <file> [--section all|colors|typography|radii|borders|shadows|spacing|css]
  components <file> [--limit 100]       Component definitions and instance counts

Files:
  render <file> --id <id> [--format svg|png] [--out path]
                                        SVG to stdout, or the file given by --out (PNG requires --out)
      PNG size: fits within 1600 px by default; --max-width, --max-height, or --scale 2 to change it.
      PNGs over 50 Mpx are refused unless --allow-large.
  asset <file> --hash <sha1> --out <path>
                                        Original bytes of an embedded image
  export <file> --out <dir> [--png]     Everything above, written to a directory

MCP:
  mcp <file>                            Serve the same MCP tools as the server over stdio
`;

// A reader that stops early (head, or quitting less) closes the pipe. That ends the output, not in an error.
process.stdout.on('error', error => {
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0);
  throw error;
});

const COMMANDS = new Set(['status', 'layers', 'search', 'node', 'context', 'theme', 'components', 'render', 'asset', 'export', 'mcp']);
const cliMain = fileURLToPath(import.meta.url);

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    id: { type: 'string' }, hash: { type: 'string' }, out: { type: 'string' },
    depth: { type: 'string' }, limit: { type: 'string' }, section: { type: 'string' },
    format: { type: 'string' }, 'max-width': { type: 'string' }, 'max-height': { type: 'string' },
    scale: { type: 'string' }, 'allow-large': { type: 'boolean' },
    png: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  },
});

function integer(name: 'depth' | 'limit' | 'max-width' | 'max-height') {
  const raw = options[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer`);
  return value;
}

function required(name: 'id' | 'hash' | 'out') {
  const value = options[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

const print = (data: unknown) => process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);

async function main() {
  const [command, figPath, query] = positionals;
  if (options.help) { process.stdout.write(usage); return; }
  if (!command) {
    if (process.stdin.isTTY) return startInteractive(undefined, { cliMain });
    process.stdout.write(usage);
    return;
  }
  if (!COMMANDS.has(command)) {
    if (positionals.length === 1) return startInteractive(command, { cliMain });
    throw new Error(`Unknown command ${command}\n\n${usage}`);
  }
  if (!figPath) throw new Error(`Provide a .fig file\n\n${usage}`);

  const document = await openDocument(figPath);
  const { workspace } = document;

  switch (command) {
    case 'status': return print(documentSummary(workspace.status()));
    case 'layers': return print(workspace.tree(options.id, integer('depth') ?? 2));
    case 'search':
      if (!query) throw new Error('Provide a search query');
      return print(workspace.search(query, integer('limit')));
    case 'node': return print(workspace.node(required('id')));
    case 'context': return print(commandReferences(workspace.implementationContext(required('id'), integer('depth'), integer('limit')), figPath));
    case 'theme': return print(themeSection(workspace.theme(), options.section ?? 'all'));
    case 'components': return print(workspace.components(integer('limit')));
    case 'render': {
      const id = required('id');
      const format = options.format ?? 'svg';
      if (format === 'svg') {
        const rendered = workspace.render(id);
        if (!options.out) { process.stdout.write(rendered.svg); return; }
        await writeFile(options.out, rendered.svg);
        return print({ out: options.out, format, width: rendered.width, height: rendered.height, warnings: rendered.warnings });
      }
      if (format !== 'png') throw new Error('--format must be svg or png');
      const out = required('out');
      const image = await renderPng(document, id, { maxWidth: integer('max-width'), maxHeight: integer('max-height'),
        scale: options.scale === undefined ? undefined : Number(options.scale), allowLarge: options['allow-large'] });
      await writeFile(out, image.bytes);
      return print({ out, format, width: image.width, height: image.height, scale: Number(image.scale.toFixed(4)),
        designWidth: image.designWidth, designHeight: image.designHeight });
    }
    case 'asset': {
      const hash = required('hash').toLowerCase();
      const asset = workspace.asset(hash);
      const out = required('out');
      const path = /\.\w+$/.test(out) ? out : `${out}.${asset.format}`;
      await writeFile(path, asset.bytes);
      return print({ out: path, hash, source: 'fig', format: asset.format, bytes: asset.bytes.length });
    }
    case 'export':
      return print(await exportDocument(workspace, document.file, resolve(required('out')), {
        png: options.png ? pngInChildProcess(cliMain, document.path) : undefined, log: line => process.stderr.write(`${line}\n`) }));
    case 'mcp':
      // stdout belongs to JSON-RPC from here on; diagnostics go to stderr.
      await createMcpServer(workspace, 'tool').connect(new StdioServerTransport());
      return;
  }
}

main().catch(error => {
  process.stderr.write(`lienza: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
