export interface DesignVersion {
  id: string;
  number: number;
  fileName: string;
  uploadedAt: string;
  size: number;
}

export interface DesignProject {
  id: string;
  name: string;
  createdAt: string;
  versions: DesignVersion[];
}

export interface ProjectCatalog {
  projects: DesignProject[];
  activeProjectId: string | null;
  activeVersionId: string | null;
}

export interface ProjectRepository {
  list(): Promise<ProjectCatalog>;
  create(name: string, sourcePath: string, fileName: string): Promise<DesignProject>;
  addVersion(projectId: string, sourcePath: string, fileName: string): Promise<DesignProject>;
  versionPath(projectId: string, versionId: string): Promise<string>;
  activate(projectId: string, versionId: string): Promise<void>;
  prune(projectId: string): Promise<DesignProject>;
  delete(projectId: string): Promise<void>;
  hasCatalog(): Promise<boolean>;
}
