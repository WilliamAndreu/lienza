import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Workspace } from '../../application/workspace.js';
import { ProjectLibrary } from '../../application/project-library.js';
import { openFigLoader } from '../out/openfig-loader.js';
import { registerHttpRoutes } from './http.js';
import type { ProjectRepository } from '../../domain/projects.js';

const pngSize = (bytes: Buffer) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });

test('PNG render fits within 1600 px when no size is requested', { skip: !process.env.FIGMA_PROJECTS_TEST_FILE }, async () => {
  const app = Fastify();
  const workspace = new Workspace(openFigLoader);
  await registerHttpRoutes(app, workspace, new ProjectLibrary({} as ProjectRepository, openFigLoader, workspace));
  try {
    const status = await workspace.open(process.env.FIGMA_PROJECTS_TEST_FILE!);
    const page = [...status.pages].filter(item => item.visible && item.childCount > 0)
      .map(item => ({ id: item.id, ...workspace.render(item.id) }))
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    assert.ok(page);
    const response = await app.inject(`/api/render/${encodeURIComponent(page.id)}.png?v=${encodeURIComponent(status.renderKey)}`);
    assert.equal(response.statusCode, 200);
    const size = pngSize(response.rawPayload);
    assert.ok(size.width <= 1600 && size.height <= 1600, `${size.width}×${size.height}`);
    if (page.width > 1600 || page.height > 1600) assert.ok(size.width === 1600 || size.height === 1600);
  } finally { await app.close(); }
});
