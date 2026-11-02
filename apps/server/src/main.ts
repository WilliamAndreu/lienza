import Fastify from 'fastify';
import { Workspace } from './application/workspace.js';
import { openFigLoader } from './adapters/out/openfig-loader.js';
import { registerHttpRoutes } from './adapters/in/http.js';
import { LocalProjectRepository } from './adapters/out/local-project-repository.js';
import { ProjectLibrary } from './application/project-library.js';
import { resolve } from 'node:path';

const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
const workspace = new Workspace(openFigLoader);
const library = new ProjectLibrary(
  new LocalProjectRepository(resolve(process.env.FIGMA_LIBRARY_DIR ?? 'data/projects')),
  openFigLoader,
  workspace,
);
await registerHttpRoutes(app, workspace, library);

await library.initialize(process.env.FIGMA_FILE);
if (workspace.status().loaded) {
  app.log.info({ name: workspace.status().name, nodes: workspace.status().nodeCount }, 'Loaded .fig file');
}

await app.listen({ port: Number(process.env.PORT ?? 3210), host: process.env.HOST ?? '127.0.0.1' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void app.close(); });
}
