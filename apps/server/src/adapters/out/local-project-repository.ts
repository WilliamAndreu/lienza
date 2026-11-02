import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DesignProject, DesignVersion, ProjectCatalog, ProjectRepository } from '../../domain/projects.js';

interface StoredCatalog extends ProjectCatalog {}

export class LocalProjectRepository implements ProjectRepository {
  private readonly manifestPath: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) {
    this.manifestPath = join(directory, 'projects.json');
  }

  async list(): Promise<ProjectCatalog> {
    const catalog = await this.read();
    return {
      projects: catalog.projects.map(project => ({ ...project, versions: [...project.versions].sort((a, b) => b.number - a.number) }))
        .sort((a, b) => (b.versions[0]?.uploadedAt ?? b.createdAt).localeCompare(a.versions[0]?.uploadedAt ?? a.createdAt)),
      activeProjectId: catalog.activeProjectId,
      activeVersionId: catalog.activeVersionId,
    };
  }

  async hasCatalog(): Promise<boolean> {
    try { await stat(this.manifestPath); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async create(name: string, sourcePath: string, fileName: string): Promise<DesignProject> {
    return this.exclusive(() => this.createStored(name, sourcePath, fileName));
  }

  private async createStored(name: string, sourcePath: string, fileName: string): Promise<DesignProject> {
    const catalog = await this.read();
    if (catalog.projects.some(project => project.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new Error('A project with that name already exists');
    }
    const project: DesignProject = { id: randomUUID(), name, createdAt: new Date().toISOString(), versions: [] };
    const version = await this.copyVersion(project.id, 1, sourcePath, fileName);
    project.versions.push(version);
    catalog.projects.push(project);
    try { await this.write(catalog); }
    catch (error) { await rm(join(this.directory, project.id), { recursive: true, force: true }); throw error; }
    return project;
  }

  async addVersion(projectId: string, sourcePath: string, fileName: string): Promise<DesignProject> {
    return this.exclusive(() => this.addStoredVersion(projectId, sourcePath, fileName));
  }

  private async addStoredVersion(projectId: string, sourcePath: string, fileName: string): Promise<DesignProject> {
    const catalog = await this.read();
    const project = this.requireProject(catalog, projectId);
    const number = Math.max(0, ...project.versions.map(version => version.number)) + 1;
    const version = await this.copyVersion(projectId, number, sourcePath, fileName);
    project.versions.push(version);
    try { await this.write(catalog); }
    catch (error) { await rm(this.filePath(projectId, version.id), { force: true }); throw error; }
    return project;
  }

  async versionPath(projectId: string, versionId: string): Promise<string> {
    const catalog = await this.read();
    const project = this.requireProject(catalog, projectId);
    if (!project.versions.some(version => version.id === versionId)) throw new Error('Version not found');
    return this.filePath(projectId, versionId);
  }

  async activate(projectId: string, versionId: string): Promise<void> {
    return this.exclusive(() => this.activateStored(projectId, versionId));
  }

  private async activateStored(projectId: string, versionId: string): Promise<void> {
    const catalog = await this.read();
    const project = this.requireProject(catalog, projectId);
    if (!project.versions.some(version => version.id === versionId)) throw new Error('Version not found');
    catalog.activeProjectId = projectId;
    catalog.activeVersionId = versionId;
    await this.write(catalog);
  }

  async prune(projectId: string): Promise<DesignProject> {
    return this.exclusive(() => this.pruneStored(projectId));
  }

  private async pruneStored(projectId: string): Promise<DesignProject> {
    const catalog = await this.read();
    const project = this.requireProject(catalog, projectId);
    const latest = [...project.versions].sort((a, b) => b.number - a.number)[0];
    if (!latest) throw new Error('Project has no versions');
    const oldVersions = project.versions.filter(version => version.id !== latest.id);
    project.versions = [latest];
    if (catalog.activeProjectId === projectId && catalog.activeVersionId !== latest.id) catalog.activeVersionId = latest.id;
    await this.write(catalog);
    const projectDirectory = join(this.directory, projectId);
    const files = await readdir(projectDirectory);
    await Promise.all(oldVersions.flatMap(version => files
      .filter(file => file === `${version.id}.fig` || file.startsWith(`${version.id}.fig.preview-`))
      .map(file => rm(join(projectDirectory, file), { force: true }))));
    return project;
  }

  async delete(projectId: string): Promise<void> {
    return this.exclusive(() => this.deleteStored(projectId));
  }

  private async deleteStored(projectId: string): Promise<void> {
    const catalog = await this.read();
    this.requireProject(catalog, projectId);
    const projectDirectory = join(this.directory, projectId);
    const stagedDirectory = join(this.directory, `.deleting-${projectId}-${randomUUID()}`);
    let staged = false;
    try {
      await rename(projectDirectory, stagedDirectory);
      staged = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    catalog.projects = catalog.projects.filter(project => project.id !== projectId);
    if (catalog.activeProjectId === projectId) {
      catalog.activeProjectId = null;
      catalog.activeVersionId = null;
    }
    try { await this.write(catalog); }
    catch (error) {
      if (staged) await rename(stagedDirectory, projectDirectory);
      throw error;
    }
    if (staged) await rm(stagedDirectory, { recursive: true, force: true });
  }

  private async read(): Promise<StoredCatalog> {
    try { return JSON.parse(await readFile(this.manifestPath, 'utf8')) as StoredCatalog; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { projects: [], activeProjectId: null, activeVersionId: null };
      throw error;
    }
  }

  private async write(catalog: StoredCatalog): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.manifestPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(catalog, null, 2));
      await rename(temporary, this.manifestPath);
    } catch (error) { await rm(temporary, { force: true }); throw error; }
  }

  private requireProject(catalog: StoredCatalog, id: string): DesignProject {
    const project = catalog.projects.find(item => item.id === id);
    if (!project) throw new Error('Project not found');
    return project;
  }

  private filePath(projectId: string, versionId: string) { return join(this.directory, projectId, `${versionId}.fig`); }

  private async copyVersion(projectId: string, number: number, sourcePath: string, fileName: string): Promise<DesignVersion> {
    const id = randomUUID();
    const destination = this.filePath(projectId, id);
    await mkdir(join(this.directory, projectId), { recursive: true });
    try { await copyFile(sourcePath, destination); }
    catch (error) { await rm(destination, { force: true }); throw error; }
    const { size } = await stat(destination);
    return { id, number, fileName, uploadedAt: new Date().toISOString(), size };
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
}
