import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { useColor } from './interactive/format.js';
import { logo } from './interactive/logo.js';
import { EXIT, Session } from './interactive/session.js';

const figFile = process.env.FIGMA_PROJECTS_TEST_FILE;
const main = fileURLToPath(new URL('./main.ts', import.meta.url));

async function session() {
  const cwd = await mkdtemp(join(tmpdir(), 'lienza-session-'));
  let output = '';
  const clipboard: string[] = [];
  const opened: string[] = [];
  const instance = new Session({ cliMain: main, cwd, write: text => { output += text; },
    copy: text => { clipboard.push(text); }, openFile: path => { opened.push(path); } });
  const run = async (line: string) => { output = ''; const result = await instance.run(line); return { output, result }; };
  return { instance, run, cwd, clipboard, opened };
}

test('Navigates like a directory: ls numbers children, cd moves, the prompt follows', { skip: !figFile }, async () => {
  const { instance, run, cwd } = await session();
  try {
    await instance.open(figFile!);
    const { output: pages } = await run('pages');
    assert.match(pages, /^\s+1 {2}\S/m);
    await run('cd /');
    const page = instance.document!.workspace.status().pages.find(item => item.visible && item.childCount > 0)!;
    await run(`cd ${page.id}`);
    assert.equal(instance.currentId, page.id);
    assert.match(instance.prompt(), new RegExp(page.name.slice(0, 10).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const { output: listing } = await run('ls');
    const firstChild = instance.document!.workspace.tree(page.id, 1).children![0]!;
    assert.match(listing, new RegExp(`1 {2}${firstChild.type}`));
    await run('cd 1');
    assert.equal(instance.currentId, firstChild.id);
    const { output: info } = await run('info');
    assert.ok(info.includes(firstChild.name));
    await run('cd ..');
    assert.equal(instance.currentId, page.id);
    await run('cd -');
    assert.equal(instance.currentId, firstChild.id);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('Search results become targets, and errors keep the session alive', { skip: !figFile }, async () => {
  const { instance, run, cwd } = await session();
  try {
    await instance.open(figFile!);
    const { output } = await run('search frame');
    assert.match(output, /Type a number to go to one/);
    const first = instance.document!.workspace.search('frame', 100)[0]!;
    await run('cd 1');
    assert.equal(instance.currentId, first.id);
    assert.match((await run('foo')).output, /Unknown command "foo"/);
    assert.match((await run('cd 99999')).output, /✖ No item 99999/);
    await run(`cd ${instance.document!.workspace.status().suggestedNodeId}`);
    assert.match((await run('render png --scale 100')).output, /✖ The PNG would be[\s\S]*--allow-large/);
    assert.equal((await run('exit')).result, EXIT);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('render svg and json mode write and print the same data as the commands', { skip: !figFile }, async () => {
  const { instance, run, cwd } = await session();
  try {
    await instance.open(figFile!);
    const id = instance.document!.workspace.status().suggestedNodeId!;
    await run(`cd ${id}`);
    const { output } = await run('render svg --out frame.svg');
    assert.match(output, /✔ frame\.svg/);
    assert.match(await readFile(join(cwd, 'frame.svg'), 'utf8'), /<svg[\s\S]*<\/svg>\s*$/);
    await run('json on');
    assert.equal(JSON.parse((await run('info')).output).id, id);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('Tab completes commands, child names, and theme sections', { skip: !figFile }, async () => {
  const { instance, cwd } = await session();
  try {
    await instance.open(figFile!);
    assert.deepEqual(instance.complete('th'), [['theme'], 'th']);
    assert.deepEqual(instance.complete('theme col'), [['colors'], 'col']);
    const children = instance.document!.workspace.tree(instance.currentId!, 1).children ?? [];
    const [names] = instance.complete('cd ');
    for (const child of children) assert.ok(names.includes(child.name));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('lienza <file.fig> reads commands from a pipe', { skip: !figFile }, async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', main, figFile!], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stdin.end('pages\nexit\n');
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 0);
  assert.match(stdout, /Lienza/);
  assert.match(stdout, /❯ pages/);
  assert.doesNotMatch(stdout, /\x1b\[/, 'no colors when not writing to a terminal');
});

test('A number or .. alone moves, and cd looks in the whole file for a name it cannot find here', { skip: !figFile }, async () => {
  const { instance, run, cwd } = await session();
  try {
    await instance.open(figFile!);
    const { workspace } = instance.document!;
    const page = workspace.status().pages.find(item => item.visible && item.childCount > 0)!;
    await run(`cd ${page.id}`);
    const first = workspace.tree(page.id, 1).children![0]!;
    const { output } = await run('1');
    assert.equal(instance.currentId, first.id);
    assert.ok(output.includes(first.name), 'entering a node shows it');
    await run('..');
    assert.equal(instance.currentId, page.id);

    // A layer on another page, by exact name.
    const elsewhere = workspace.status().pages.filter(item => item.id !== page.id && item.childCount > 0)
      .flatMap(item => workspace.tree(item.id, 1).children ?? [])
      .find(node => workspace.search(node.name, 100).filter(result => result.name === node.name).length === 1);
    if (elsewhere) {
      const moved = await run(`cd ${elsewhere.name}`);
      assert.equal(instance.currentId, elsewhere.id, moved.output);
      assert.match(moved.output, /Found in/);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('Unknown commands suggest the closest one, and copy goes to the clipboard', { skip: !figFile }, async () => {
  const { instance, run, cwd, clipboard } = await session();
  try {
    await instance.open(figFile!);
    assert.match((await run('contxt')).output, /Did you mean context\?/);
    await run(`cd ${instance.document!.workspace.status().suggestedNodeId}`);
    await run('copy');
    assert.equal(JSON.parse(clipboard[0]!).file.nodeId, instance.currentId);
    await run('copy id');
    assert.equal(clipboard[1], instance.currentId);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('preview writes a PNG of the current node and opens it in the system viewer', { skip: !figFile }, async () => {
  const { instance, run, cwd, opened } = await session();
  try {
    await instance.open(figFile!);
    assert.match((await run('preview')).output, /cd into a page or a node/, 'the session starts at the document');
    await run(`cd ${instance.document!.workspace.status().suggestedNodeId}`);
    const { output } = await run('preview');
    assert.match(output, /Opened .* in your image viewer/);
    assert.equal(opened.length, 1);
    const png = await readFile(opened[0]!);
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    assert.ok(Math.max(width, height) <= 6000, 'fits within 6000 px');
    assert.ok(width * height <= 24_000_000, 'automatic preview stays within its pixel budget');
    const design = instance.document!.workspace.render(instance.currentId);
    if (Math.max(design.width, design.height) * 3 <= 6000 && design.width * design.height * 9 <= 24_000_000) {
      assert.ok(width >= design.width * 2.9, 'ordinary frames render near 3× for sharper zoom');
    }
    await rm(opened[0]!, { force: true });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('The logo falls back to one plain line without color', () => {
  useColor(false);
  assert.match(logo(), /^Lienza \d+\.\d+\.\d+ · local Figma reader$/);
});
