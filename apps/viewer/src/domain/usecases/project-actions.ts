import { inject, Injectable } from '@angular/core';
import { ProjectRepository } from '../repositories/project-repository';

@Injectable({ providedIn: 'root' })
export class ProjectActions {
  private readonly repository = inject(ProjectRepository);
  list() { return this.repository.list(); }
  create(name: string, file: File) { return this.repository.create(name, file); }
  addVersion(projectId: string, file: File) { return this.repository.addVersion(projectId, file); }
  open(projectId: string, versionId: string) { return this.repository.open(projectId, versionId); }
  keepLatest(projectId: string) { return this.repository.keepLatest(projectId); }
  delete(projectId: string) { return this.repository.delete(projectId); }
}
