import type { DesignProject, ProjectCatalog } from '../entities/project';

export abstract class ProjectRepository {
  abstract list(): Promise<ProjectCatalog>;
  abstract create(name: string, file: File): Promise<DesignProject>;
  abstract addVersion(projectId: string, file: File): Promise<DesignProject>;
  abstract open(projectId: string, versionId: string): Promise<void>;
  abstract keepLatest(projectId: string): Promise<DesignProject>;
  abstract delete(projectId: string): Promise<ProjectCatalog>;
}
