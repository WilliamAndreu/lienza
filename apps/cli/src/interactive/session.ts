import { readdirSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { formatGUID } from '@figma-reader/fig-engine';
import { openDocument, type OpenDocument } from '../document.js';
import { exportDocument } from '../export.js';
import { pngInChildProcess, pngScale } from '../png.js';
import { commandReferences, documentSummary, safeFileName, THEME_SECTIONS, themeSection } from '../references.js';
import { contextSummary, nodeInfo, pathLine, size, style, themeSummary, truncate, typeLabel } from './format.js';
import { logo } from './logo.js';
import { copyToClipboard, openWithSystem } from './system.js';

export interface SessionEnvironment {
  /** Path of the CLI entry point, used to rasterize PNGs in a child process. */
  cliMain: string;
  cwd: string;
  write: (text: string) => void;
  /** Recently opened files, most recent first, and a hook to record one. */
  recent?: () => string[];
  remember?: (path: string) => void;
  /** System integrations, replaceable in tests. */
  copy?: (text: string) => void;
  openFile?: (path: string) => void;
}

interface Command {
  usage: string;
  summary: string;
  examples?: string[];
  needsFile?: boolean;
  run: (args: string[], rest: string) => unknown;
}

export const EXIT = Symbol('exit');

const tokenize = (line: string) => [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2] ?? match[3]!);
const unquote = (text: string) => text.trim().replace(/^(["'])(.*)\1$/, '$2');
const expandHome = (path: string) => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
const layers = (count: number) => `${count} layer${count === 1 ? '' : 's'}`;
const slug = (name: string) => name.normalize('NFKD').replace(/[^\w.]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'node';
const number = (index: number) => style.gray(String(index + 1).padStart(3));
/** Typing only a location moves there, as with zsh's auto_cd. */
const BARE_LOCATION = /^(\d+|\.\.(\/\.\.)*\/?|\/|-)$/;
// Previews open in an image viewer that zooms, so they can be larger than render's default.
const PREVIEW_MAX_SIDE = 6000;
const PREVIEW_PIXEL_BUDGET = 24_000_000;
const SHORTCUTS: Record<string, string> = { back: 'cd -', up: 'cd ..', top: 'cd /', home: 'cd /' };

function distance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** One open .fig and a current node, like a working directory. Every command writes through env.write. */
export class Session {
  document?: OpenDocument;
  currentId?: string;
  json = false;
  private previousId?: string;
  private listing: string[] = [];
  private lastSaved?: string;
  readonly commands: Record<string, Command>;
  readonly aliases: Record<string, string> = {
    quit: 'exit', q: 'exit', '?': 'help', dir: 'ls', find: 'search', inspect: 'info', status: 'file', where: 'pwd', see: 'preview', look: 'preview',
  };

  constructor(private readonly env: SessionEnvironment) {
    this.commands = {
      help: { usage: 'help [command]', summary: 'Commands, or one command with examples', examples: ['help', 'help cd'], run: args => this.help(args[0]) },
      open: { usage: 'open <file.fig | number>', summary: 'Open a .fig, or one from recent', examples: ['open ~/Designs/app.fig', 'open 1'], run: (_args, rest) => this.open(unquote(rest)) },
      recent: { usage: 'recent', summary: 'Recently opened files (open <number>)', run: () => this.recent() },
      file: { usage: 'file', summary: 'Name, parser, and counts of the open file', needsFile: true, run: () => this.fileInfo() },
      pages: { usage: 'pages', summary: 'List pages; a number enters one', needsFile: true, run: () => this.pages() },
      ls: { usage: 'ls [limit]', summary: 'Children of the current node, numbered', examples: ['ls', 'ls 200'], needsFile: true, run: args => this.ls(args[0] ? Number(args[0]) : 60) },
      cd: {
        usage: 'cd <name | number | id | .. | / | ->', needsFile: true,
        summary: 'Move to a child, a listed item, a node id, the parent, the document, or back. A name not found here is searched in the whole file.',
        examples: ['cd cover', 'cd 3', 'cd 1403:4275', 'cd ..', 'cd -', '3   (same as cd 3)', '..  (same as cd ..)', 'back · up · top'],
        run: (_args, rest) => this.cd(unquote(rest)),
      },
      pwd: { usage: 'pwd', summary: 'Full path of the current node, with ids', needsFile: true, run: () => this.pwd() },
      tree: { usage: 'tree [depth]', summary: 'Layer tree below the current node (default depth 2)', examples: ['tree', 'tree 4'], needsFile: true, run: args => this.tree(args[0] ? Number(args[0]) : 2) },
      search: { usage: 'search <text>', summary: 'Find nodes by name or type, numbered', examples: ['search button', 'search TEXT', 'search dashboard  then  2'], needsFile: true, run: (_args, rest) => this.search(unquote(rest)) },
      components: { usage: 'components [limit]', summary: 'Component definitions by usage, numbered', needsFile: true, run: args => this.components(args[0] ? Number(args[0]) : 30) },
      info: { usage: 'info [target]', summary: 'Properties of the current node or a target', examples: ['info', 'info 3', 'info title'], needsFile: true, run: (_args, rest) => this.info(unquote(rest)) },
      context: { usage: 'context [depth]', summary: 'Implementation context: layout rules, components, assets, tokens', examples: ['context', 'context 2', 'json on  then  context'], needsFile: true, run: args => this.context(args[0] ? Number(args[0]) : 1) },
      theme: {
        usage: `theme [${THEME_SECTIONS.join('|')}] [limit]`, summary: 'Inferred colors, fonts, radii, borders, shadows, spacing', needsFile: true,
        examples: ['theme', 'theme colors', 'theme colors 50', 'theme css'], run: args => this.theme(args[0] ?? 'all', args[1] ? Number(args[1]) : undefined),
      },
      preview: { usage: 'preview [target] [--scale n]', summary: 'Open the current node, or a target, in the system image viewer', examples: ['preview', 'preview 1', 'preview Cover', 'preview --scale 1'], needsFile: true, run: args => this.preview(args) },
      copy: {
        usage: 'copy [context|info|css|svg|id|path]', summary: 'Copy to the clipboard, ready to paste into an agent (default: context)', needsFile: true,
        examples: ['copy', 'copy css', 'copy id'], run: args => this.copy(args[0] ?? 'context'),
      },
      render: {
        usage: 'render [png|svg] [--scale n] [--max-width n] [--max-height n] [--allow-large] [--out path]', summary: 'Save the current node as PNG (default) or SVG', needsFile: true,
        examples: ['render', 'render svg', 'render --scale 2', 'render --out ~/Desktop/frame.png'], run: args => this.render(args),
      },
      asset: { usage: 'asset <hash> [--out path]', summary: 'Save an embedded image listed by context', examples: ['asset 4394'], needsFile: true, run: args => this.asset(args) },
      export: { usage: 'export <dir> [--png]', summary: 'Write everything to a directory', examples: ['export ./design-export', 'export out --png'], needsFile: true, run: args => this.export(args) },
      view: { usage: 'view [path]', summary: 'Open the last saved file or folder with the system viewer', run: (_args, rest) => this.view(unquote(rest)) },
      json: { usage: 'json [on|off]', summary: 'Print raw JSON instead of summaries', run: args => this.toggleJson(args[0]) },
      clear: { usage: 'clear', summary: 'Clear the screen', run: () => this.env.write('\x1b[2J\x1b[H') },
      exit: { usage: 'exit', summary: 'Leave (also Ctrl-D)', run: () => EXIT },
    };
  }

  private print(text = '') { this.env.write(`${text}\n`); }
  private printJson(data: unknown) { this.print(JSON.stringify(data, null, 2)); }
  private shown(path: string) { return relative(this.env.cwd, path) || path; }

  private get doc() {
    if (!this.document) throw new Error('No .fig is open. Use: open <file.fig>');
    return this.document;
  }
  private get ws() { return this.doc.workspace; }
  private get rootId() { return formatGUID(this.doc.file.document.guid); }
  private get current() { return this.currentId ?? this.rootId; }
  private children(id = this.current) { return this.ws.tree(id, 1).children ?? []; }

  /** Runs one line. Returns EXIT when the session should end. */
  async run(line: string): Promise<typeof EXIT | void> {
    let trimmed = line.trim();
    if (!trimmed) return;
    if (BARE_LOCATION.test(trimmed) && this.document) trimmed = `cd ${trimmed}`;
    const shortcut = SHORTCUTS[trimmed.toLowerCase()];
    if (shortcut) trimmed = shortcut;
    const [rawName = ''] = trimmed.split(/\s+/, 1);
    const name = this.resolveName(rawName.replace(/^\//, ''));
    const command = name && this.commands[name];
    if (!command) { this.print(style.red(`Unknown command "${rawName}".`) + style.gray(` ${this.suggest(trimmed)}`)); return; }
    const rest = trimmed.slice(rawName.length).trim();
    try {
      if (command.needsFile) void this.doc;
      if ((await command.run(tokenize(rest), rest)) === EXIT) return EXIT;
    } catch (error) {
      this.print(style.red(`✖ ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  resolveName(name: string) {
    const lower = name.toLowerCase();
    return this.commands[lower] ? lower : this.aliases[lower];
  }

  /** A hint for an unknown command: a child with that name, or the closest command. */
  private suggest(text: string) {
    const lower = text.toLowerCase();
    if (this.document) {
      const child = this.children().find(item => item.name.toLowerCase() === lower)
        ?? this.children().find(item => item.name.toLowerCase().startsWith(lower));
      if (child) return `Did you mean ${style.bold(`cd ${child.name}`)}?`;
    }
    const word = lower.split(/\s+/)[0]!.replace(/^\//, '');
    const [closest] = [...Object.keys(this.commands), ...Object.keys(this.aliases)]
      .map(candidate => ({ candidate, score: distance(word, candidate) }))
      .sort((a, b) => a.score - b.score);
    return closest && closest.score <= 2 ? `Did you mean ${style.bold(closest.candidate)}? help lists the rest.` : 'help lists them.';
  }

  prompt() {
    if (!this.document) return `${style.bold('lienza')} ${style.magenta('❯')} `;
    const path = this.ws.path(this.current);
    const shown = path.length ? path.slice(-2).map(item => truncate(item.name, 28)).join(' › ') : basename(this.doc.path);
    return `${style.cyan(`${path.length > 2 ? '… › ' : ''}${shown}`)} ${style.magenta('❯')} `;
  }

  banner(options: { opening?: boolean; firstRun?: boolean } = {}) {
    this.print();
    this.print(logo());
    this.print();
    if (options.firstRun) {
      this.print(`  ${style.bold('Welcome.')} Lienza reads a .fig on this machine. Move through it like folders:`);
      this.print(style.gray('    pages            list pages; type a number to enter one'));
      this.print(style.gray('    ls · cd · ..     children, move in, move up (a number alone also moves)'));
      this.print(style.gray('    info · context   what this node is, and how to build it'));
      this.print(style.gray('    preview · copy   open it in your image viewer, or copy its context for an agent'));
      this.print(style.gray('    help             everything else. Tab completes, ↑ recalls, exit leaves.'));
    } else {
      this.print(style.gray('  help lists commands · Tab completes · a number or .. moves · exit leaves'));
    }
    const recent = this.env.recent?.() ?? [];
    if (!options.opening && recent.length) {
      this.print();
      this.print(`  ${style.bold('Recent')} ${style.gray('· open <number>')}`);
      recent.slice(0, 5).forEach((path, index) => this.print(`  ${number(index)}  ${basename(path)}  ${style.gray(truncate(dirname(path), 60))}`));
    } else if (!options.opening) {
      this.print(style.gray('  open <file.fig> to start.'));
    }
    this.print();
  }

  async open(target: string) {
    if (!target) throw new Error('Usage: open <file.fig | number>');
    const recent = this.env.recent?.() ?? [];
    const path = /^\d+$/.test(target) && recent[Number(target) - 1] ? recent[Number(target) - 1]! : resolve(this.env.cwd, expandHome(target));
    this.print(style.gray(`Opening ${path}…`));
    const started = performance.now();
    const document = await openDocument(path);
    this.document = document;
    // Start at the document: its pages are its children, so ls and numbers mean the same as anywhere else.
    this.currentId = undefined;
    this.previousId = undefined;
    this.listing = [];
    this.env.remember?.(path);
    this.fileInfo(((performance.now() - started) / 1000).toFixed(1));
    this.print();
    this.pages();
  }

  private recent() {
    const recent = this.env.recent?.() ?? [];
    if (!recent.length) return this.print(style.gray('No recent files yet.'));
    recent.forEach((path, index) => this.print(`  ${number(index)}  ${basename(path)}  ${style.gray(dirname(path))}`));
    this.print(style.gray('  open <number> opens one.'));
  }

  private fileInfo(seconds?: string) {
    const status = this.ws.status();
    const summary = documentSummary(status);
    if (this.json) return this.printJson(summary);
    const components = this.ws.components(1).total;
    this.print(`${style.bold(summary.name ?? basename(this.doc.path))}${seconds ? style.gray(`  opened in ${seconds} s`) : ''}`);
    this.print(style.gray(`${summary.nodeCount.toLocaleString()} nodes · ${summary.pages.length} pages · ${summary.imageCount} images · ${components} components · ${summary.parser} v${summary.version}`));
  }

  private setListing(ids: string[]) { this.listing = ids; }

  private pages() {
    const pages = this.ws.status().pages;
    if (this.json) return this.printJson(pages);
    this.setListing(pages.map(page => page.id));
    pages.forEach((page, index) => this.print(`  ${number(index)}  ${page.visible ? page.name : style.dim(`${page.name} (hidden)`)}  ${style.gray(layers(page.childCount))}`
));
    this.print(style.gray('  Type a number to enter a page.'));
  }

  private childRow(index: number, child: { id: string; name: string; type: string; visible: boolean; childCount: number }) {
    const node = this.ws.node(child.id);
    const extra = node.text != null ? `"${truncate(node.text.replace(/\s+/g, ' '), 36)}"` : child.childCount ? layers(child.childCount) : '';
    const line = `  ${number(index)}  ${typeLabel(child.type, 9)} ${truncate(child.name, 36).padEnd(36)} ${style.gray(size(node.width, node.height).padEnd(11))} ${style.gray(extra)}`;
    return child.visible ? line : style.dim(`${line}  hidden`);
  }

  private ls(limit: number) {
    const children = this.children();
    if (this.json) return this.printJson(children);
    if (!children.length) return this.print(style.gray('No children.'));
    this.setListing([]); // numbers now refer to these children
    children.slice(0, limit).forEach((child, index) => this.print(this.childRow(index, child)));
    if (children.length > limit) this.print(style.gray(`  … ${children.length - limit} more (ls ${children.length})`));
  }

  /** Resolves a target: listing number, node id, name of a child, .., /, or - (previous). Undefined when no child has that name. */
  private target(text: string): string | undefined {
    const file = this.doc.file;
    if (!text || text === '.') return this.current;
    if (text === '/') return this.rootId;
    if (text === '-') { if (!this.previousId) throw new Error('No previous location'); return this.previousId; }
    if (/^(\.\.\/?)+$/.test(text)) {
      let id = this.current;
      for (let step = 0; step < text.split('..').length - 1; step++) {
        const path = this.ws.path(id);
        id = path.length >= 2 ? path[path.length - 2]!.id : this.rootId;
      }
      return id;
    }
    if (/^\d+$/.test(text)) {
      // A number refers to the last search, pages, or components list, or else to the children ls numbers.
      const ids = this.listing.length ? this.listing : this.children().map(child => child.id);
      const id = ids[Number(text) - 1];
      if (!id) throw new Error(`No item ${text} ${this.listing.length ? 'in the last list' : 'among the children here'} (${ids.length} items)`);
      return id;
    }
    if (/^\d+:\d+$/.test(text)) { if (!file.nodeIndex.has(text)) throw new Error(`Node ${text} not found`); return text; }
    const children = this.children();
    const lower = text.toLowerCase();
    const matches = [
      children.filter(child => child.name.toLowerCase() === lower),
      children.filter(child => child.name.toLowerCase().startsWith(lower)),
      children.filter(child => child.name.toLowerCase().includes(lower)),
    ].find(group => group.length);
    if (!matches) return undefined;
    if (matches.length > 1 && matches[0]!.name.toLowerCase() !== lower) {
      throw new Error(`"${text}" matches ${matches.length} children: ${matches.slice(0, 5).map(child => child.name).join(', ')}${matches.length > 5 ? ', …' : ''}`);
    }
    return matches[0]!.id;
  }

  private requireTarget(text: string) {
    const id = this.target(text);
    if (!id) throw new Error(`No child named "${text}" here. ls lists them; cd ${text} also searches the whole file.`);
    return id;
  }

  private moveTo(id: string) {
    if (id !== this.current) { this.previousId = this.current; this.currentId = id; }
    this.listing = [];
    if (id === this.rootId) return this.pages();
    const node = this.ws.node(id);
    this.print(`${typeLabel(node.type)} ${style.bold(node.name)} ${style.gray([size(node.width, node.height), layers(node.childCount)].filter(Boolean).join(' · '))}`);
    const children = this.children();
    children.slice(0, 8).forEach((child, index) => this.print(this.childRow(index, child)));
    if (children.length > 8) this.print(style.gray(`  … ${children.length - 8} more (ls)`));
  }

  private cd(text: string) {
    const id = this.target(text || '/');
    if (id) return this.moveTo(id);
    // Not a child here: look for the name in the whole file.
    const lower = text.toLowerCase();
    const found = this.ws.search(text, 100).filter(result => result.name.toLowerCase().includes(lower));
    const exact = found.filter(result => result.name.toLowerCase() === lower);
    const only = exact.length === 1 ? exact[0] : found.length === 1 ? found[0] : undefined;
    if (only) {
      this.print(style.gray(`Found in ${pathLine(this.ws.path(only.id).slice(0, -1))}`));
      return this.moveTo(only.id);
    }
    if (!found.length) throw new Error(`Nothing named "${text}" in this file. search looks by name or type.`);
    this.setListing(found.map(result => result.id));
    this.print(style.gray(`No child "${text}" here; ${found.length >= 100 ? '100+' : found.length} layers elsewhere match. Type a number to go:`));
    for (const [index, result] of found.slice(0, 20).entries()) {
      this.print(`  ${number(index)}  ${typeLabel(result.type, 9)} ${truncate(result.name, 40).padEnd(40)} ${style.gray(truncate(this.ws.path(result.id)[0]?.name ?? '', 24))}`);
    }
  }

  private pwd() {
    const path = this.ws.path(this.current);
    if (this.json) return this.printJson(path);
    if (!path.length) return this.print(style.gray(`${basename(this.doc.path)} (document)`));
    path.forEach((item, index) => this.print(`  ${' '.repeat(index * 2)}${index ? style.gray('└ ') : ''}${typeLabel(item.type)} ${item.name} ${style.gray(item.id)}`));
  }

  private tree(depth: number) {
    const tree = this.ws.tree(this.current, Math.max(1, Math.min(depth, 6)));
    if (this.json) return this.printJson(tree);
    let lines = 0;
    const walk = (node: typeof tree, prefix: string, last: boolean, top: boolean) => {
      if (lines++ > 300) return;
      const label = `${typeLabel(node.type)} ${node.visible ? node.name : style.dim(`${node.name} (hidden)`)} ${style.gray(node.id)}`;
      this.print(top ? label : `${prefix}${last ? '└─ ' : '├─ '}${label}`);
      const children = node.children ?? [];
      children.forEach((child, index) => walk(child, top ? '' : `${prefix}${last ? '   ' : '│  '}`, index === children.length - 1, false));
      if (!node.children && node.childCount) this.print(`${prefix}${last ? '   ' : '│  '}${style.gray(`… ${node.childCount} more`)}`);
    };
    walk(tree, '', true, true);
    if (lines > 300) this.print(style.gray('… truncated at 300 lines. Use a smaller depth or cd into a child.'));
  }

  private info(text: string) {
    const id = this.requireTarget(text);
    if (id === this.rootId) return this.fileInfo();
    const node = this.ws.node(id);
    if (this.json) return this.printJson(node);
    this.print(nodeInfo(node, this.ws.path(id)));
  }

  private requireNode(action: string) {
    if (this.current === this.rootId) throw new Error(`cd into a page or a node to ${action} it`);
    return this.current;
  }

  private implementationContext(depth = 1) {
    return this.ws.implementationContext(this.requireNode('inspect'), Math.max(0, Math.min(depth, 2)), 60);
  }

  private context(depth: number) {
    const context = this.implementationContext(depth);
    if (this.json) return this.printJson(commandReferences(context, this.doc.path));
    this.print(contextSummary(context));
  }

  private search(text: string) {
    if (!text) throw new Error('Usage: search <text>');
    const results = this.ws.search(text, 100);
    if (this.json) return this.printJson(results);
    if (!results.length) return this.print(style.gray(`Nothing matches "${text}".`));
    this.setListing(results.map(result => result.id));
    for (const [index, result] of results.slice(0, 40).entries()) {
      const page = this.ws.path(result.id)[0]?.name ?? '';
      this.print(`  ${number(index)}  ${typeLabel(result.type, 9)} ${truncate(result.name, 40).padEnd(40)} ${style.gray(truncate(page, 24))}`);
    }
    this.print(style.gray(`  ${results.length >= 100 ? '100+' : results.length} results. Type a number to go to one${results.length > 40 ? '; the first 40 are shown' : ''}.`));
  }

  private components(limit: number) {
    const result = this.ws.components(limit);
    if (this.json) return this.printJson(result);
    const listed = result.components.filter(component => component.definitionResolved);
    this.setListing(listed.map(component => component.definitionId));
    listed.forEach((component, index) => this.print(
      `  ${number(index)}  ${truncate(component.name ?? component.definitionId, 44).padEnd(44)} ${String(component.instanceCount).padStart(5)} ${style.gray('instances')}`));
    this.print(style.gray(`  ${result.total} definitions referenced in the file. Type a number to go to one.`));
  }

  private theme(section: string, limit?: number) {
    if (!(THEME_SECTIONS as readonly string[]).includes(section)) throw new Error(`Sections: ${THEME_SECTIONS.join(', ')}`);
    const theme = this.ws.theme();
    if (this.json) return this.printJson(themeSection(theme, section));
    this.print(themeSummary(theme, section, limit));
  }

  /**
   * Renders the current node to a temporary PNG and opens it in the system image viewer. Terminals differ
   * in whether they can show images at all; the system viewer shows it sharp from any of them.
   */
  private async preview(args: string[]) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { scale: { type: 'string' } } });
    const id = this.requireTarget(positionals.join(' '));
    if (id === this.rootId) throw new Error('cd into a page or a node to preview it');
    const node = this.ws.node(id);
    const design = this.ws.render(id);
    if (!design.width || !design.height) throw new Error('The node has no visible content');
    // By default, use 3× for normal frames while bounding both the longest side and memory use.
    // Small vector nodes such as icons still grow to about 800 px so they are visible.
    const longest = Math.max(design.width, design.height);
    const scale = values.scale !== undefined ? Number(values.scale) : Math.min(
      PREVIEW_MAX_SIDE / longest,
      Math.sqrt(PREVIEW_PIXEL_BUDGET * 0.999 / (design.width * design.height)),
      Math.max(3, 800 / longest),
    );
    pngScale(design.width, design.height, { scale });
    const directory = join(tmpdir(), 'lienza-preview');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${slug(node.name)}-${safeFileName(id)}.png`);
    const image = await pngInChildProcess(this.env.cliMain, this.doc.path)(id, path, { scale });
    (this.env.openFile ?? openWithSystem)(path);
    this.print(style.gray(`Opened ${node.name} (${image.width}×${image.height} · ${Number(image.scale.toFixed(2))}×) in your image viewer. render keeps a copy in lienza-out.`));
    this.sparseHint(id, design.width * design.height);
  }

  /**
   * A page renders the area that holds all its layers, so one layer far from the rest leaves the design
   * small in a mostly empty image. Points to the largest layer instead.
   */
  private sparseHint(id: string, area: number) {
    const boxes = this.children(id).filter(child => child.visible).map(child => {
      const node = this.ws.node(child.id);
      return { id: child.id, name: child.name, width: node.width ?? 0, height: node.height ?? 0 };
    });
    if (boxes.length < 2) return;
    const covered = boxes.reduce((sum, box) => sum + box.width * box.height, 0);
    if (covered / area >= 0.25) return;
    const largest = [...boxes].sort((a, b) => b.width * b.height - a.width * a.height)[0]!;
    // A number is only unambiguous when it would refer to this node's children.
    const index = this.children(id).findIndex(child => child.id === largest.id);
    const target = id === this.current && !this.listing.length ? String(index + 1) : largest.id;
    this.print(style.yellow(`  Mostly empty space: its ${boxes.length} layers are spread apart, so each one looks small.`));
    this.print(style.gray(`  ${style.bold(`preview ${target}`)} shows ${largest.name} (${size(largest.width, largest.height)}) alone; ls lists the others.`));
  }

  private copy(what: string) {
    const name = (id: string) => this.ws.node(id).name;
    let text: string;
    let label: string;
    switch (what) {
      case 'context': text = JSON.stringify(commandReferences(this.implementationContext(1), this.doc.path), null, 2); label = `context of ${name(this.current)}`; break;
      case 'info': text = JSON.stringify(this.ws.node(this.requireNode('copy')), null, 2); label = `properties of ${name(this.current)}`; break;
      case 'css': text = this.ws.theme().cssVariables; label = 'theme CSS variables'; break;
      case 'svg': text = this.ws.render(this.requireNode('copy')).svg; label = `SVG of ${name(this.current)}`; break;
      case 'id': text = this.current; label = `id ${this.current}`; break;
      case 'path':
        if (!this.lastSaved) throw new Error('Nothing saved yet');
        text = this.lastSaved; label = this.shown(this.lastSaved); break;
      default: throw new Error('copy context, info, css, svg, id, or path');
    }
    (this.env.copy ?? copyToClipboard)(text);
    this.print(`${style.green('✔')} Copied ${label} ${style.gray(`(${text.length >= 1024 ? `${(text.length / 1024).toFixed(0)} KB` : `${text.length} chars`})`)}`);
  }

  private saved(path: string, details: string) {
    this.lastSaved = path;
    this.print(`${style.green('✔')} ${this.shown(path)} ${style.gray(details)}  ${style.gray('· view opens it')}`);
  }

  private async render(args: string[]) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      out: { type: 'string' }, scale: { type: 'string' }, 'max-width': { type: 'string' }, 'max-height': { type: 'string' }, 'allow-large': { type: 'boolean' } } });
    const format = positionals[0] ?? 'png';
    if (format !== 'png' && format !== 'svg') throw new Error('Format must be png or svg');
    const id = this.requireNode('render');
    const node = this.ws.node(id);
    const suffix = format === 'png' && values.scale && Number(values.scale) !== 1 ? `@${values.scale}x` : '';
    const out = resolve(this.env.cwd, expandHome(values.out ?? join('lienza-out', `${slug(node.name)}-${safeFileName(node.id)}${suffix}.${format}`)));
    await mkdir(dirname(out), { recursive: true });
    if (format === 'svg') {
      const rendered = this.ws.render(id);
      await writeFile(out, rendered.svg);
      return this.saved(out, size(rendered.width, rendered.height));
    }
    const value = (name: 'scale' | 'max-width' | 'max-height') => values[name] === undefined ? undefined : Number(values[name]);
    const pngSize = { scale: value('scale'), maxWidth: value('max-width'), maxHeight: value('max-height'), allowLarge: values['allow-large'] };
    const design = this.ws.render(id);
    pngScale(design.width, design.height, pngSize);
    // In a child process: a renderer abort must not end the session.
    const image = await pngInChildProcess(this.env.cliMain, this.doc.path)(id, out, pngSize);
    this.saved(out, `${image.width}×${image.height}${image.scale !== 1 ? ` · scale ${Number(image.scale.toFixed(3))}` : ''}`);
  }

  private async asset(args: string[]) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { out: { type: 'string' } } });
    const hash = positionals[0]?.toLowerCase();
    if (!hash) throw new Error('Usage: asset <hash> [--out path]. context lists the hashes.');
    const full = /^[a-f0-9]{40}$/.test(hash) ? hash : this.doc.file.images.listHashes().find(item => item.toLowerCase().startsWith(hash))?.toLowerCase();
    if (!full) throw new Error(`No embedded image starts with ${hash}`);
    const asset = this.ws.asset(full);
    const out = resolve(this.env.cwd, expandHome(values.out ?? join('lienza-out', `${full}.${asset.format}`)));
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, asset.bytes);
    this.saved(out, `${asset.format} · ${(asset.bytes.length / 1024).toFixed(0)} KB`);
  }

  private async export(args: string[]) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { png: { type: 'boolean' } } });
    if (!positionals[0]) throw new Error('Usage: export <dir> [--png]');
    const out = resolve(this.env.cwd, expandHome(positionals[0]));
    const result = await exportDocument(this.ws, this.doc.file, out, {
      png: values.png ? pngInChildProcess(this.env.cliMain, this.doc.path) : undefined,
      log: line => this.print(style.gray(`  ${line}`)) });
    if (this.json) return this.printJson(result);
    this.saved(out, `${result.pages} pages · ${result.frames} frames · ${result.assets} images${result.failures ? ` · ${result.failures} with errors (see manifest.json)` : ''}`);
  }

  private view(target: string) {
    const path = target ? resolve(this.env.cwd, expandHome(target)) : this.lastSaved;
    if (!path) throw new Error('Nothing saved yet. render, asset, or export first, or pass a path.');
    (this.env.openFile ?? openWithSystem)(path);
    this.print(style.gray(`Opened ${this.shown(path)}`));
  }

  private toggleJson(value?: string) {
    this.json = value === undefined ? !this.json : value === 'on';
    this.print(style.gray(`JSON output ${this.json ? 'on' : 'off'}`));
  }

  private help(name?: string) {
    if (name) {
      const command = this.commands[this.resolveName(name.replace(/^\//, '')) ?? ''];
      if (!command) throw new Error(`Unknown command ${name}`);
      this.print(`  ${style.bold(command.usage)}`);
      this.print(`  ${command.summary}`);
      if (command.examples?.length) {
        this.print();
        for (const example of command.examples) this.print(`    ${style.cyan(example)}`);
      }
      return;
    }
    const groups: Array<[string, string[]]> = [
      ['Navigate', ['pages', 'ls', 'cd', 'pwd', 'tree', 'search', 'components']],
      ['Inspect', ['info', 'context', 'theme', 'preview', 'file']],
      ['Take it with you', ['copy', 'render', 'asset', 'export', 'view']],
      ['Session', ['open', 'recent', 'json', 'clear', 'help', 'exit']],
    ];
    for (const [title, names] of groups) {
      this.print(`  ${style.bold(title)}`);
      for (const commandName of names) this.print(`    ${commandName.padEnd(12)} ${style.gray(this.commands[commandName]!.summary)}`);
      this.print();
    }
    this.print(style.gray('  A number alone moves to that item (3), .. goes up, - goes back. help <command> shows examples.'));
  }

  /** Readline completer: commands, then child names, sections, formats, or paths depending on the command. */
  complete(line: string): [string[], string] {
    const space = line.indexOf(' ');
    if (space === -1) {
      const slash = line.startsWith('/') ? '/' : '';
      const names = Object.keys(this.commands).map(name => `${slash}${name}`);
      const hits = names.filter(name => name.startsWith(line.toLowerCase()));
      return [hits.length ? hits : names, line];
    }
    const name = this.resolveName(line.slice(0, space).replace(/^\//, ''));
    const rest = line.slice(space + 1);
    const filter = (options: string[]) => {
      const hits = options.filter(option => option.toLowerCase().startsWith(rest.toLowerCase()));
      return [hits, rest] as [string[], string];
    };
    try {
      if ((name === 'cd' || name === 'info') && this.document) return filter(['..', '/', ...this.children().map(child => child.name)]);
      if (name === 'theme') return filter([...THEME_SECTIONS]);
      if (name === 'copy') return filter(['context', 'info', 'css', 'svg', 'id', 'path']);
      if (name === 'json') return filter(['on', 'off']);
      if (name === 'help') return filter(Object.keys(this.commands));
      if (name === 'render' && !rest.includes(' ')) return filter(['png', 'svg']);
      if (name === 'render') {
        const last = rest.slice(rest.lastIndexOf(' ') + 1);
        return [['--scale', '--max-width', '--max-height', '--allow-large', '--out'].filter(flag => flag.startsWith(last)), last];
      }
      if (name === 'open' || name === 'export' || name === 'view') return this.completePath(rest, name === 'open');
    } catch { /* completion never interrupts typing */ }
    return [[], rest];
  }

  private completePath(partial: string, figOnly: boolean): [string[], string] {
    const directoryPart = partial.endsWith('/') ? partial : dirname(partial) === '.' && !partial.startsWith('./') ? '' : `${dirname(partial)}/`;
    const prefix = partial.slice(directoryPart.length);
    const directory = resolve(this.env.cwd, expandHome(directoryPart || '.'));
    const entries = readdirSync(directory).filter(entry => entry.startsWith(prefix) && (prefix.startsWith('.') || !entry.startsWith('.')));
    const hits = entries.flatMap(entry => {
      let isDirectory = false;
      try { isDirectory = statSync(join(directory, entry)).isDirectory(); } catch { return []; }
      if (figOnly && !isDirectory && !entry.toLowerCase().endsWith('.fig')) return [];
      return [`${directoryPart}${entry}${isDirectory ? '/' : ''}`];
    });
    return [hits, partial];
  }
}
