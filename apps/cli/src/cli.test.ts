import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const figFile = process.env.FIGMA_PROJECTS_TEST_FILE;
const main = fileURLToPath(new URL('./main.ts', import.meta.url));
const cli = (...args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', main, ...args], { maxBuffer: 256 * 1024 * 1024 });

test('Queries print JSON without server URLs', { skip: !figFile }, async () => {
  const status = JSON.parse((await cli('status', figFile!)).stdout);
  assert.ok(status.nodeCount > 0);
  assert.ok(status.suggestedNodeId);
  const { stdout } = await cli('context', figFile!, '--id', status.suggestedNodeId);
  assert.doesNotMatch(stdout, /\/api\//);
  assert.match(JSON.parse(stdout).visualReferences.svgCommand, /^lienza render /);
});

test('Errors go to stderr with a non-zero exit code', { skip: !figFile }, async () => {
  await assert.rejects(cli('node', figFile!, '--id', '999999:999999'), (error: { code: number; stderr: string }) =>
    error.code === 1 && /^lienza: Node 999999:999999 not found/.test(error.stderr));
});

test('MCP over stdio exposes the server tools', { skip: !figFile }, async () => {
  const client = new Client({ name: 'lienza-cli-test', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', main, 'mcp', figFile!] }));
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some(tool => tool.name === 'get_implementation_context'));
    const result = await client.callTool({ name: 'get_document_status', arguments: {} }) as { content: Array<{ text: string }> };
    const status = JSON.parse(result.content[0]!.text);
    assert.equal(status.loaded, true);
    const contextResult = await client.callTool({ name: 'get_implementation_context',
      arguments: { node_id: status.suggestedNodeId, depth: 0 } }) as { content: Array<{ text: string }> };
    const context = JSON.parse(contextResult.content[0]!.text);
    assert.equal(context.visualReferences.renderTool.name, 'render_node');
    assert.doesNotMatch(contextResult.content[0]!.text, /\/api\//);
  } finally { await client.close(); }
});

test('Export writes a manifest whose references resolve to files', { skip: !figFile }, async () => {
  const out = await mkdtemp(join(tmpdir(), 'lienza-export-'));
  try {
    await cli('export', figFile!, '--out', out);
    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    assert.ok(manifest.pages.length > 0);
    const frame = manifest.frames.find((entry: { svg: string | null }) => entry.svg);
    assert.ok(frame);
    await readFile(join(out, frame.svg));
    const context = JSON.parse(await readFile(join(out, frame.context), 'utf8'));
    assert.equal(context.visualReferences.svgFile, `../${frame.svg}`);
    for (const image of context.assets.images) if (image.file) await readFile(join(out, 'frames', image.file));
  } finally { await rm(out, { recursive: true, force: true }); }
});

test('PNG fits within 1600 px by default and refuses sizes over the pixel budget', { skip: !figFile }, async () => {
  const out = await mkdtemp(join(tmpdir(), 'lienza-png-'));
  try {
    const status = JSON.parse((await cli('status', figFile!)).stdout);
    const page = status.pages.find((item: { visible: boolean; childCount: number }) => item.visible && item.childCount > 0);
    const fitted = JSON.parse((await cli('render', figFile!, '--id', page.id, '--format', 'png', '--out', join(out, 'page.png'))).stdout);
    assert.ok(fitted.width <= 1600 && fitted.height <= 1600);
    assert.ok(fitted.scale <= 1);

    const huge = join(out, 'huge.png');
    await assert.rejects(cli('render', figFile!, '--id', status.suggestedNodeId, '--format', 'png', '--scale', '100', '--out', huge),
      (error: { code: number; stderr: string }) => error.code === 1 && /--allow-large/.test(error.stderr));
    await assert.rejects(readFile(huge));
  } finally { await rm(out, { recursive: true, force: true }); }
});
