import type { FastifyInstance, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Workspace } from '../../application/workspace.js';
import type { ProjectLibrary } from '../../application/project-library.js';
import { handleMcpRequest } from './mcp.js';

const PROJECT_PLACEHOLDER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 480" width="960" height="480">
  <rect width="960" height="480" fill="#eae9ed"/>
  <path d="M0 120H960M0 240H960M0 360H960M240 0V480M480 0V480M720 0V480" stroke="#d4d1dc" stroke-width="1"/>
  <rect x="286" y="82" width="388" height="316" rx="8" fill="#f9f9fa" stroke="#33343e" stroke-width="2"/>
  <rect x="310" y="106" width="340" height="196" rx="3" fill="#dcd9e5"/>
  <circle cx="480" cy="204" r="48" fill="none" stroke="#65609e" stroke-width="12"/>
  <path d="m459 204 15 15 29-33" fill="none" stroke="#65609e" stroke-linecap="round" stroke-linejoin="round" stroke-width="11"/>
  <path d="M310 331h192M310 353h134" stroke="#aca9b8" stroke-linecap="round" stroke-width="11"/>
</svg>`;

export async function registerHttpRoutes(app: FastifyInstance, workspace: Workspace, library: ProjectLibrary) {
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 1 } });
  const uploadDir = await mkdtemp(join(tmpdir(), 'figma-reader-'));
  app.addHook('onClose', async () => { await rm(uploadDir, { recursive: true, force: true }); });

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = (error as { statusCode?: number }).statusCode ?? (/not found/i.test(message) ? 404 : 400);
    reply.code(status).send({ error: message });
  });

  async function receiveFig(request: FastifyRequest) {
    const file = await request.file();
    if (!file || !file.filename.toLowerCase().endsWith('.fig')) throw new Error('Select a .fig file');
    const path = join(uploadDir, `${Date.now()}-${randomUUID()}.fig`);
    try { await pipeline(file.file, createWriteStream(path)); }
    catch (error) { await rm(path, { force: true }); throw error; }
    return { path, fileName: file.filename as string };
  }

  app.get('/api/projects', async () => library.list());
  app.get('/api/projects/:id/versions/:versionId/thumbnail', async (request, reply) => {
    const { id, versionId } = request.params as { id: string; versionId: string };
    const image = await library.thumbnail(id, versionId);
    if (!image) return reply.type('image/svg+xml').header('Cache-Control', 'private, max-age=31536000, immutable').send(PROJECT_PLACEHOLDER);
    reply.type('image/png').header('Cache-Control', 'private, max-age=31536000, immutable');
    return Buffer.from(image);
  });
  app.post('/api/projects', async request => {
    const { name = '' } = request.query as { name?: string };
    const upload = await receiveFig(request);
    try { return await library.create(name, upload.path, upload.fileName); }
    finally { await rm(upload.path, { force: true }); }
  });
  app.post('/api/projects/:id/versions', async request => {
    const { id } = request.params as { id: string };
    const upload = await receiveFig(request);
    try { return await library.addVersion(id, upload.path, upload.fileName); }
    finally { await rm(upload.path, { force: true }); }
  });
  app.post('/api/projects/:id/versions/:versionId/open', async request => {
    const { id, versionId } = request.params as { id: string; versionId: string };
    return library.activate(id, versionId);
  });
  app.delete('/api/projects/:id/versions', async request => {
    const { id } = request.params as { id: string };
    const { keep } = request.query as { keep?: string };
    if (keep !== 'latest') throw new Error('Set keep=latest to retain only the latest version');
    return library.prune(id);
  });
  app.delete('/api/projects/:id', async request => {
    const { id } = request.params as { id: string };
    return library.delete(id);
  });

  app.get('/api/status', async () => workspace.status());
  app.get('/api/theme', async () => workspace.theme());
  app.get('/api/tree', async request => {
    const { pageId, depth } = request.query as { pageId?: string; depth?: string };
    return workspace.tree(pageId, depth ? Number(depth) : 10);
  });
  app.get('/api/nodes/:id', async request => workspace.node((request.params as { id: string }).id));
  app.get('/api/nodes/:id/path', async request => workspace.path((request.params as { id: string }).id));
  app.get('/api/search', async request => {
    const { q = '', limit } = request.query as { q?: string; limit?: string };
    return workspace.search(q, limit ? Number(limit) : 50);
  });
  app.get('/api/selection', async () => workspace.selection());
  app.post('/api/selection', async request => {
    const body = request.body as { id?: string | null; renderKey?: string };
    workspace.requireRenderKey(body?.renderKey);
    return workspace.select(body?.id ?? null);
  });
  app.post('/api/view', async request => {
    const body = request.body as { id?: string; renderKey?: string };
    if (!body?.id) throw new Error('Provide the node to display on the canvas');
    workspace.requireRenderKey(body.renderKey);
    return workspace.view(body.id);
  });
  app.get('/api/render/:id.svg', async (request, reply) => {
    workspace.requireRenderKey((request.query as { v?: string }).v);
    const rendered = workspace.render((request.params as { id: string }).id, {
      includeCanvasBackground: (request.query as { canvasBackground?: string }).canvasBackground !== 'none',
    });
    reply.type('image/svg+xml; charset=utf-8').header('Cache-Control', 'private, max-age=31536000, immutable');
    return rendered.svg;
  });
  app.get('/api/render/:id.png', async (request, reply) => {
    const query = request.query as { v?: string; maxWidth?: string; maxHeight?: string };
    workspace.requireRenderKey(query.v);
    const maxWidth = query.maxWidth === undefined ? undefined : Number(query.maxWidth);
    const maxHeight = query.maxHeight === undefined ? undefined : Number(query.maxHeight);
    if ((maxWidth !== undefined && (!Number.isInteger(maxWidth) || maxWidth < 100 || maxWidth > 1600))
      || (maxHeight !== undefined && (!Number.isInteger(maxHeight) || maxHeight < 100 || maxHeight > 1600))) {
      throw new Error('maxWidth and maxHeight must be between 100 and 1600');
    }
    // Always fit within 1600 px: at full size, memory grows with the page's pixel area and can exhaust the machine.
    const rendered = await workspace.screenshot((request.params as { id: string }).id,
      { maxWidth: maxWidth ?? 1600, maxHeight: maxHeight ?? 1600 });
    reply.type('image/png').header('Cache-Control', 'no-store');
    return Buffer.from(rendered.base64, 'base64');
  });
  app.get('/api/assets/:hash', async (request, reply) => {
    workspace.requireRenderKey((request.query as { v?: string }).v);
    const asset = workspace.asset((request.params as { hash: string }).hash.toLowerCase());
    reply.type(asset.mimeType).header('Cache-Control', 'private, max-age=31536000, immutable');
    return Buffer.from(asset.bytes);
  });
  app.get('/api/hit-areas/:id', async request => workspace.hitAreas((request.params as { id: string }).id));
  app.get('/api/thumbnail', async (_request, reply) => {
    const image = workspace.thumbnail();
    if (!image) return reply.code(404).send({ error: 'No thumbnail available' });
    reply.type('image/png');
    return Buffer.from(image);
  });
  app.post('/api/documents', async (request, reply) => {
    const upload = await receiveFig(request);
    try {
      const name = upload.fileName.replace(/\.fig$/i, '');
      const existing = (await library.list()).projects.find(project => project.name.toLocaleLowerCase() === name.toLocaleLowerCase());
      const project = existing
        ? await library.addVersion(existing.id, upload.path, upload.fileName)
        : await library.create(name, upload.path, upload.fileName);
      return library.activate(project.id, project.versions.at(-1)!.id);
    } finally { await rm(upload.path, { force: true }); }
  });

  app.post('/mcp', async (request, reply) => {
    reply.hijack();
    try { await handleMcpRequest(workspace, request.raw, reply.raw, request.body); }
    catch (error) {
      app.log.error(error);
      if (!reply.raw.headersSent) reply.raw.writeHead(500, { 'content-type': 'application/json' });
      reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
    }
  });
  app.get('/mcp', async (_request, reply) => reply.code(405).send());
  app.delete('/mcp', async (_request, reply) => reply.code(405).send());
}
