import { Injectable } from '@angular/core';
import { readApi } from '../../core/http';
import type { DesignProject, ProjectCatalog } from '../../domain/entities/project';
import { ProjectRepository } from '../../domain/repositories/project-repository';

@Injectable()
export class HttpProjectRepository extends ProjectRepository {
  list() { return fetch('/api/projects').then(readApi<ProjectCatalog>); }
  create(name: string, file: File) {
    return this.upload(`/api/projects?name=${encodeURIComponent(name)}`, file);
  }
  addVersion(projectId: string, file: File) {
    return this.upload(`/api/projects/${encodeURIComponent(projectId)}/versions`, file);
  }
  async open(projectId: string, versionId: string) {
    await readApi(await fetch(`/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/open`, { method: 'POST' }));
  }
  keepLatest(projectId: string) {
    return fetch(`/api/projects/${encodeURIComponent(projectId)}/versions?keep=latest`, { method: 'DELETE' }).then(readApi<DesignProject>);
  }
  delete(projectId: string) {
    return fetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' }).then(readApi<ProjectCatalog>);
  }
  private upload(url: string, file: File) {
    const data = new FormData();
    data.set('file', file);
    return fetch(url, { method: 'POST', body: data }).then(readApi<DesignProject>);
  }
}
