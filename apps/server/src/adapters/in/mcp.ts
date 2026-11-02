import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Workspace } from '../../application/workspace.js';

function result(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function createMcpServer(workspace: Workspace) {
  const server = new McpServer({ name: 'lienza-local', version: '0.1.0' });
  server.registerTool('get_document_status', {
    description: 'Status of the loaded local .fig file, including pages, selection, and the view open on the canvas.',
  }, async () => result(workspace.status()));
  server.registerTool('get_theme', {
    description: 'Visual tokens inferred from the active .fig. In typography.fonts, declaredFamily is the design font and renderedFamily is only the configured preview substitute; use declaredFamily when implementing. Includes frequency, examples, and CSS variables. These are not declared Figma variables.',
    inputSchema: { section: z.enum(['all', 'colors', 'typography', 'radii', 'borders', 'shadows', 'spacing', 'css']).optional(), limit: z.number().int().min(1).max(100).optional() },
  }, async ({ section = 'all', limit = 30 }) => {
    const theme = workspace.theme();
    const observed = <T extends object>(items: T[]) => items.slice(0, limit).map(item => ({ ...item,
      provenance: { value: 'fig', grouping: 'inferred' } }));
    const sections = {
      colors: observed(theme.colors),
      typography: { fonts: observed(theme.typography.fonts), styles: observed(theme.typography.styles) },
      radii: observed(theme.radii), borders: observed(theme.borders), shadows: observed(theme.shadows),
      spacing: theme.spacing.slice(0, limit).map(item => ({ ...item,
        provenance: { value: item.source === 'auto-layout' ? 'fig' : 'inferred', grouping: 'inferred' } })),
    };
    const css = { cssVariables: theme.cssVariables, cssVariablesProvenance: 'inferred' };
    if (section === 'css') return result({ source: theme.source, ...css, notes: theme.notes });
    if (section !== 'all') return result({ source: theme.source, [section]: sections[section], notes: theme.notes });
    return result({ source: theme.source, ...sections, ...css, notes: theme.notes });
  });
  server.registerTool('get_selection', {
    description: 'Returns the selected node, open view, and canvasBounds in the same coordinates as the SVG and viewer. renderKey identifies the active .fig version.',
  }, async () => result(workspace.selection()));
  server.registerTool('list_layers', {
    description: 'Lists the layer tree for a page or node.',
    inputSchema: { node_id: z.string().optional(), depth: z.number().int().min(0).max(10).optional() },
  }, async ({ node_id, depth }) => result(workspace.tree(node_id, depth ?? 2)));
  server.registerTool('search_nodes', {
    description: 'Searches nodes by name or type in the local document.',
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(100).optional() },
  }, async ({ query, limit }) => result(workspace.search(query, limit)));
  server.registerTool('get_node_context', {
    description: 'Returns a node’s design properties, text, colors, and child layers. typography.declaredFamily preserves the font declared in the .fig even when the viewer uses typography.renderedFamily.',
    inputSchema: { node_id: z.string() },
  }, async ({ node_id }) => result(workspace.node(node_id)));
  server.registerTool('get_implementation_context', {
    description: 'Verifiable implementation context for a node: original .fig auto layout rules and constraints, component references, embedded assets, observed tokens, and visual references. Each block indicates its provenance. Does not generate code or infer breakpoints.',
    inputSchema: { node_id: z.string().optional(), depth: z.number().int().min(0).max(2).optional(), limit: z.number().int().min(1).max(100).optional() },
  }, async ({ node_id, depth, limit }) => result(workspace.implementationContext(node_id, depth, limit)));
  server.registerTool('list_components', {
    description: 'Lists component definitions referenced by .fig instances and their usage counts. Definitions may appear as FRAME nodes in the file.',
    inputSchema: { limit: z.number().int().min(1).max(200).optional() },
  }, async ({ limit }) => result(workspace.components(limit)));
  server.registerTool('get_image_asset', {
    description: 'Returns the original bytes of an image asset embedded in the .fig. Use a hash returned by get_implementation_context.',
    inputSchema: { hash: z.string().regex(/^[a-fA-F0-9]{40}$/) },
  }, async ({ hash }) => {
    const image = workspace.asset(hash.toLowerCase());
    return { content: [{ type: 'image' as const, data: Buffer.from(image.bytes).toString('base64'), mimeType: image.mimeType },
      { type: 'text' as const, text: JSON.stringify({ hash: hash.toLowerCase(), source: 'fig', format: image.format, bytes: image.bytes.length }) }] };
  });
  server.registerTool('render_node', {
    description: 'Returns dimensions, warnings, and the local SVG URL. Set include_svg only when you need the complete vector markup.',
    inputSchema: { node_id: z.string(), include_svg: z.boolean().optional() },
  }, async ({ node_id, include_svg }) => {
    const rendered = workspace.render(node_id);
    const renderKey = workspace.status().renderKey;
    return result({ width: rendered.width, height: rendered.height, renderKey,
      url: `/api/render/${encodeURIComponent(node_id)}.svg?v=${encodeURIComponent(renderKey)}`,
      ...(include_svg ? { svg: rendered.svg } : {}), warnings: rendered.warnings });
  });
  server.registerTool('get_node_image', {
    description: 'Returns a compact PNG preview of a design node for visual analysis.',
    inputSchema: { node_id: z.string(), max_width: z.number().int().min(100).max(1600).optional(), max_height: z.number().int().min(100).max(1600).optional() },
  }, async ({ node_id, max_width, max_height }) => {
    const image = await workspace.screenshot(node_id, { maxWidth: max_width ?? 960, maxHeight: max_height ?? 960 });
    return { content: [{ type: 'image' as const, data: image.base64, mimeType: 'image/png' }, { type: 'text' as const, text: JSON.stringify({ width: image.width, height: image.height, nodeId: node_id, renderKey: workspace.status().renderKey }) }] };
  });
  return server;
}

export async function handleMcpRequest(workspace: Workspace, request: IncomingMessage, response: ServerResponse, body: unknown) {
  const server = createMcpServer(workspace);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  response.on('close', () => { void transport.close(); void server.close(); });
  await transport.handleRequest(request, response, body);
}
