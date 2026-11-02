import { Component, inject, OnInit, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LowerCasePipe } from '@angular/common';
import { TranslatePipe } from '@ngx-translate/core';
import type { DesignProject, DesignVersion, ProjectCatalog } from '../../domain/entities/project';
import { ProjectActions } from '../../domain/usecases/project-actions';
import { BrandMark } from '../shared/brand-mark';
import { LanguageSelector } from '../shared/language-selector';
import { LanguageService } from '../../core/language.service';

@Component({
  selector: 'app-project-library-view',
  standalone: true,
  imports: [RouterLink, BrandMark, LanguageSelector, TranslatePipe, LowerCasePipe],
  templateUrl: './project-library-view.html',
})
export class ProjectLibraryView implements OnInit {
  private readonly actions = inject(ProjectActions);
  private readonly router = inject(Router);
  readonly language = inject(LanguageService);
  readonly catalog = signal<ProjectCatalog | null>(null);
  readonly projectName = signal('');
  readonly newFile = signal<File | null>(null);
  readonly busy = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly confirmAction = signal<{ projectId: string; type: 'prune' | 'delete' } | null>(null);

  ngOnInit() { void this.refresh(); }

  async refresh() {
    try { this.catalog.set(await this.actions.list()); }
    catch (error) { this.fail(error); }
  }

  chooseNewFile(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0] ?? null;
    this.newFile.set(file);
    if (file && !this.projectName().trim()) this.projectName.set(file.name.replace(/\.fig$/i, ''));
  }

  async createProject() {
    const file = this.newFile();
    const name = this.projectName().trim();
    if (!file || !file.name.toLowerCase().endsWith('.fig')) { this.error.set(this.language.t('library.selectFigError')); return; }
    if (!name) { this.error.set(this.language.t('library.nameError')); return; }
    await this.run('create', async () => {
      await this.actions.create(name, file);
      this.projectName.set(''); this.newFile.set(null);
      const input = document.querySelector<HTMLInputElement>('#new-project-file');
      if (input) input.value = '';
      await this.refresh();
      this.notice.set(this.language.t('library.created', { name }));
    });
  }

  async addVersion(project: DesignProject, event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.fig')) { this.error.set(this.language.t('library.selectFigError')); return; }
    await this.run(project.id, async () => {
      await this.actions.addVersion(project.id, file);
      await this.refresh();
      this.notice.set(this.language.t('library.versionAdded', { name: project.name }));
    });
  }

  async open(project: DesignProject, version: DesignVersion) {
    await this.run(`open-${version.id}`, async () => {
      await this.actions.open(project.id, version.id);
      await this.router.navigateByUrl('/reader');
    });
  }

  async keepLatest(project: DesignProject) {
    await this.run(project.id, async () => {
      await this.actions.keepLatest(project.id);
      this.confirmAction.set(null);
      await this.refresh();
      this.notice.set(this.language.t('library.keptLatest', { name: project.name }));
    });
  }

  async deleteProject(project: DesignProject) {
    await this.run(project.id, async () => {
      this.catalog.set(await this.actions.delete(project.id));
      this.confirmAction.set(null);
      this.notice.set(this.language.t('library.projectDeleted', { name: project.name }));
      document.getElementById('projects-title')?.focus();
    });
  }

  confirm(projectId: string, type: 'prune' | 'delete') {
    const current = this.confirmAction();
    this.confirmAction.set(current?.projectId === projectId && current.type === type ? null : { projectId, type });
  }

  cancelConfirmation(projectId: string, type: 'prune' | 'delete') {
    this.confirmAction.set(null);
    document.getElementById(`${type}-project-${projectId}`)?.focus();
  }

  formatDate(value: string) {
    return this.language.formatDate(value);
  }

  formatSize(bytes: number) { return this.language.formatSize(bytes); }
  thumbnailUrl(project: DesignProject, version: DesignVersion) {
    return `/api/projects/${encodeURIComponent(project.id)}/versions/${encodeURIComponent(version.id)}/thumbnail?preview=v1`;
  }
  isActive(projectId: string, versionId: string) {
    return this.catalog()?.activeProjectId === projectId && this.catalog()?.activeVersionId === versionId;
  }
  dismissMessages() { this.error.set(null); this.notice.set(null); }

  private async run(key: string, action: () => Promise<void>) {
    this.busy.set(key); this.dismissMessages();
    try { await action(); }
    catch (error) { this.fail(error); }
    finally { this.busy.set(null); }
  }

  private fail(error: unknown) { this.error.set(this.language.errorMessage(error)); }
}
