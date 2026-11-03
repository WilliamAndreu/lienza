import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Workspace } from '../../application/workspace.js';
import { ProjectLibrary } from '../../application/project-library.js';
import { LocalProjectRepository } from '../out/local-project-repository.js';
import { openFigLoader } from '../out/openfig-loader.js';
import { registerHttpRoutes } from './http.js';

test('API: serves a lightweight placeholder when no real cover or thumbnail exists', async () => {
  const app = Fastify();
  try {
    await registerHttpRoutes(app, {} as Workspace, { thumbnail: async () => undefined } as unknown as ProjectLibrary);
    const response = await app.inject('/api/projects/example/versions/one/thumbnail');
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] as string, /^image\/svg\+xml/);
    assert.match(response.body, /viewBox="0 0 960 480"/);
  } finally { await app.close(); }
});

test('API: manages versions and deletes an active project', { skip: !process.env.FIGMA_TEST_FILE }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lienza-http-test-'));
  const app = Fastify();
  const workspace = new Workspace(openFigLoader);
  const library = new ProjectLibrary(new LocalProjectRepository(directory), openFigLoader, workspace);
  try {
    await registerHttpRoutes(app, workspace, library);
    const file = await readFile(process.env.FIGMA_TEST_FILE!);
    const upload = (url: string) => {
      const boundary = 'figura-test-boundary';
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Rudo Dashboard.fig"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        file,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return app.inject({ method: 'POST', url, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    };

    const created = await upload('/api/projects?name=Rudo%20Dashboard');
    assert.equal(created.statusCode, 200);
    const projectId = created.json().id as string;
    assert.equal(created.json().versions.length, 1);

    const updated = await upload(`/api/projects/${projectId}/versions`);
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(updated.json().versions.map((version: { number: number }) => version.number), [1, 2]);
    const firstId = updated.json().versions[0].id as string;
    const latestId = updated.json().versions[1].id as string;
    const thumbnail = await app.inject(`/api/projects/${projectId}/versions/${latestId}/thumbnail`);
    assert.equal(thumbnail.statusCode, 200);
    assert.match(thumbnail.headers['content-type'] as string, /^image\/png/);
    assert.deepEqual([...thumbnail.rawPayload.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const embedded = await openFigLoader.thumbnail(process.env.FIGMA_TEST_FILE!);
    if (embedded && Buffer.from(embedded).readUInt32BE(16) === 400 && Buffer.from(embedded).readUInt32BE(20) === 284) {
      assert.equal(thumbnail.rawPayload.readUInt32BE(16), 1800);
      assert.equal(thumbnail.rawPayload.readUInt32BE(20), 1280);
      assert.deepEqual(await readFile(join(directory, projectId, `${latestId}.fig.preview-v4.png`)), thumbnail.rawPayload);
    }

    const opened = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/versions/${firstId}/open` });
    assert.equal(opened.statusCode, 200);
    assert.equal(opened.json().loaded, true);
    assert.equal((await app.inject('/api/projects')).json().activeVersionId, firstId);

    const theme = await app.inject('/api/theme');
    assert.equal(theme.statusCode, 200);
    assert.ok(theme.json().colors.length > 0);
    assert.ok(theme.json().typography.fonts.length > 0);

    const currentPage = opened.json().pages.find((page: { childCount: number }) => page.childCount > 0);
    assert.ok(currentPage);
    const layers = (await app.inject(`/api/tree?pageId=${encodeURIComponent(currentPage.id)}&depth=1`)).json().children;
    const viewed = await app.inject({ method: 'POST', url: '/api/view', payload: { id: layers[0].id } });
    assert.equal(viewed.statusCode, 200);
    assert.equal(viewed.json().viewingNodeId, layers[0].id);
    assert.equal((await app.inject('/api/selection')).json().viewingNodeId, layers[0].id);
    assert.equal((await app.inject(`/api/nodes/${encodeURIComponent(layers[0].id)}/path`)).json().at(-1).id, layers[0].id);

    const pruned = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/versions?keep=latest` });
    assert.equal(pruned.statusCode, 200);
    assert.deepEqual(pruned.json().versions.map((version: { id: string }) => version.id), [latestId]);
    assert.equal((await app.inject('/api/projects')).json().activeVersionId, latestId);
    const active = (await app.inject('/api/status')).json();
    assert.notEqual(active.renderKey, opened.json().renderKey);
    const staleSelection = await app.inject({ method: 'POST', url: '/api/selection', payload: { id: layers[0].id, renderKey: opened.json().renderKey } });
    const staleView = await app.inject({ method: 'POST', url: '/api/view', payload: { id: layers[0].id, renderKey: opened.json().renderKey } });
    const staleRender = await app.inject(`/api/render/${encodeURIComponent(layers[0].id)}.svg?v=${encodeURIComponent(opened.json().renderKey)}`);
    assert.equal(staleSelection.statusCode, 409);
    assert.equal(staleView.statusCode, 409);
    assert.equal(staleRender.statusCode, 409);
    assert.equal((await app.inject('/api/selection')).json().selectedId, null);
    assert.equal((await app.inject(`/api/render/${encodeURIComponent(layers[0].id)}.svg?v=${encodeURIComponent(active.renderKey)}`)).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${projectId}/versions/${firstId}/open` })).statusCode, 404);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}` });
    assert.equal(deleted.statusCode, 200);
    assert.deepEqual(deleted.json().projects, []);
    assert.equal(deleted.json().activeProjectId, null);
    const cleared = (await app.inject('/api/status')).json();
    assert.equal(cleared.loaded, false);
    assert.equal(cleared.selectedId, null);
    assert.notEqual(cleared.renderKey, active.renderKey);
    assert.equal((await app.inject(`/api/render/${encodeURIComponent(layers[0].id)}.svg?v=${encodeURIComponent(active.renderKey)}`)).statusCode, 409);
    assert.equal((await app.inject(`/api/projects/${projectId}/versions/${latestId}/thumbnail`)).statusCode, 404);
    await assert.rejects(readFile(join(directory, projectId, `${latestId}.fig`)), { code: 'ENOENT' });
    const restored = new ProjectLibrary(new LocalProjectRepository(directory), openFigLoader, new Workspace(openFigLoader));
    await restored.initialize(process.env.FIGMA_TEST_FILE!);
    assert.deepEqual((await restored.list()).projects, []);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
