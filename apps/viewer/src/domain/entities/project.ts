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
