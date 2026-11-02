import type { FigLoader } from '../domain/ports.js';
import type { DesignProject, ProjectRepository } from '../domain/projects.js';
import type { Workspace } from './workspace.js';

export class ProjectLibrary {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly projects: ProjectRepository,
    private readonly loader: FigLoader,
    private readonly workspace: Workspace,
  ) {}

  list() { return this.projects.list(); }

  async thumbnail(projectId: string, versionId: string) {
    const path = await this.projects.versionPath(projectId, versionId);
    try { return await this.loader.preview(path) ?? await this.loader.thumbnail(path); }
    catch { return this.loader.thumbnail(path); }
  }

  async create(name: string, path: string, fileName: string): Promise<DesignProject> {
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 100) throw new Error('Project name must be 1 to 100 characters long');
    await this.loader.load(path);
    return this.projects.create(cleanName, path, fileName);
  }

  async addVersion(projectId: string, path: string, fileName: string): Promise<DesignProject> {
    await this.loader.load(path);
    return this.projects.addVersion(projectId, path, fileName);
  }

  activate(projectId: string, versionId: string) {
    return this.exclusive(() => this.activateStored(projectId, versionId));
  }

  private async activateStored(projectId: string, versionId: string) {
    const catalog = await this.projects.list();
    const project = catalog.projects.find(item => item.id === projectId);
    const version = project?.versions.find(item => item.id === versionId);
    if (!project || !version) throw new Error('Version not found');
    await this.workspace.open(await this.projects.versionPath(projectId, versionId), version.fileName);
    await this.projects.activate(projectId, versionId);
    return this.workspace.status();
  }

  prune(projectId: string) {
    return this.exclusive(() => this.pruneStored(projectId));
  }

  private async pruneStored(projectId: string) {
    const catalog = await this.projects.list();
    const project = catalog.projects.find(item => item.id === projectId);
    if (!project) throw new Error('Project not found');
    const latest = project.versions[0];
    if (!latest) throw new Error('Project has no versions');
    if (catalog.activeProjectId === projectId && catalog.activeVersionId !== latest.id) await this.activateStored(projectId, latest.id);
    return this.projects.prune(projectId);
  }

  delete(projectId: string) {
    return this.exclusive(() => this.deleteStored(projectId));
  }

  private async deleteStored(projectId: string) {
    const catalog = await this.projects.list();
    const wasActive = catalog.activeProjectId === projectId;
    await this.projects.delete(projectId);
    if (wasActive) this.workspace.clear();
    return this.projects.list();
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  async initialize(seedPath?: string) {
    const hasCatalog = await this.projects.hasCatalog();
    const catalog = await this.projects.list();
    if (seedPath && !hasCatalog && catalog.projects.length === 0) {
      const name = seedPath.split(/[\\/]/).pop()!.replace(/\.fig$/i, '');
      const project = await this.create(name, seedPath, `${name}.fig`);
      await this.activate(project.id, project.versions[0]!.id);
      return;
    }
    if (catalog.activeProjectId && catalog.activeVersionId) {
      await this.activate(catalog.activeProjectId, catalog.activeVersionId);
    }
  }
}
