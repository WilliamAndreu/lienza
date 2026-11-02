import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Workspace } from '../../application/workspace.js';
import { openFigLoader } from '../out/openfig-loader.js';
import { createMcpServer } from './mcp.js';

function toolJson(result: unknown) {
  const response = result as { content: Array<{ type: string; text?: string }> };
  const block = response.content.find(item => item.type === 'text');
  assert.ok(block?.text);
  return JSON.parse(block.text) as Record<string, unknown>;
}

test('MCP shares view, selection, coordinates, and version with the engine', {
  skip: !process.env.FIGMA_PROJECTS_TEST_FILE,
}, async () => {
  const workspace = new Workspace(openFigLoader);
  const status = await workspace.open(process.env.FIGMA_PROJECTS_TEST_FILE!);
  const page = status.pages.find(item => item.visible && item.childCount > 0);
  assert.ok(page);
  const frame = workspace.tree(page.id).children?.find(item => item.visible && item.type === 'FRAME');
  assert.ok(frame);

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(workspace);
  const client = new Client({ name: 'lienza-sync-test', version: '0.1.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    workspace.view(page.id);
    workspace.select(frame.id);
    const selection = toolJson(await client.callTool({ name: 'get_selection', arguments: {} }));
    assert.equal(selection.selectedId, frame.id);
    assert.equal(selection.viewingNodeId, page.id);
    assert.equal(selection.renderKey, status.renderKey);
    assert.deepEqual(selection.canvasBounds, workspace.hitAreas(page.id).find(area => area.id === frame.id));

    const render = toolJson(await client.callTool({ name: 'render_node', arguments: { node_id: frame.id } }));
    assert.equal(render.renderKey, status.renderKey);
    assert.equal(render.url, `/api/render/${encodeURIComponent(frame.id)}.svg?v=${encodeURIComponent(status.renderKey)}`);
    assert.equal(render.width, workspace.render(frame.id).width);

    const nextStatus = await workspace.open(process.env.FIGMA_PROJECTS_TEST_FILE!);
    const nextSelection = toolJson(await client.callTool({ name: 'get_selection', arguments: {} }));
    assert.equal(nextSelection.selectedId, null);
    assert.equal(nextSelection.renderKey, nextStatus.renderKey);
    assert.notEqual(nextSelection.renderKey, selection.renderKey);
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP provides original layout rules, components, and .fig assets with provenance', {
  skip: !process.env.FIGMA_PROJECTS_TEST_FILE,
}, async () => {
  const workspace = new Workspace(openFigLoader);
  await workspace.open(process.env.FIGMA_PROJECTS_TEST_FILE!);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(workspace);
  const client = new Client({ name: 'lienza-implementation-test', version: '0.1.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const context = toolJson(await client.callTool({ name: 'get_implementation_context', arguments: { node_id: '7:750', depth: 1 } }));
    const node = context.node as Record<string, unknown>;
    const layout = node.layout as Record<string, unknown>;
    const autoLayout = layout.autoLayout as { source: string; fields: Record<string, unknown> };
    assert.equal(autoLayout.source, 'fig');
    assert.equal(autoLayout.fields.stackMode, 'HORIZONTAL');
    assert.equal(autoLayout.fields.stackSpacing, 10);
    assert.equal((context.hierarchy as { included: number }).included, 2);

    const instance = toolJson(await client.callTool({ name: 'get_implementation_context', arguments: { node_id: '55:3383', depth: 0 } }));
    const instanceNode = instance.node as { component: { role: string; definitionId: string; source: string }; layout: { autoLayout: unknown; constraints: { fields: Record<string, unknown> } } };
    assert.equal(instanceNode.component.role, 'instance');
    assert.equal(instanceNode.component.definitionId, '55:3406');
    assert.equal(instanceNode.component.source, 'fig');
    assert.equal(instanceNode.layout.autoLayout, null); // Stored stack padding alone does not activate Auto Layout.
    assert.equal(instanceNode.layout.constraints.fields.horizontalConstraint, 'SCALE');

    const components = toolJson(await client.callTool({ name: 'list_components', arguments: { limit: 5 } }));
    assert.ok((components.total as number) > 50);

    const imageContext = toolJson(await client.callTool({ name: 'get_implementation_context', arguments: { node_id: '167:21201', depth: 0 } }));
    const image = ((imageContext.assets as { images: Array<{ hash: string; available: boolean }> }).images)[0];
    assert.ok(image?.available);
    const original = await client.callTool({ name: 'get_image_asset', arguments: { hash: image.hash } });
    assert.ok((original.content as Array<{ type: string }>).some(block => block.type === 'image'));
  } finally {
    await client.close();
    await server.close();
  }
});
