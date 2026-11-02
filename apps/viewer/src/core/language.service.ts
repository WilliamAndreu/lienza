import { Injectable, inject, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { NavigationEnd, Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';

export type AppLanguage = 'es' | 'en';

@Injectable({ providedIn: 'root' })
export class LanguageService {
  private readonly translate = inject(TranslateService);
  private readonly title = inject(Title);
  private readonly router = inject(Router);
  readonly current = signal<AppLanguage>('es');

  async initialize(): Promise<void> {
    const saved = this.readSavedLanguage();
    const browser = navigator.language.toLowerCase().startsWith('es') ? 'es' : 'en';
    await this.use(saved ?? browser);
    this.router.events.subscribe(event => {
      if (event instanceof NavigationEnd) this.updateTitle();
    });
  }

  async use(language: AppLanguage): Promise<void> {
    await firstValueFrom(this.translate.use(language));
    this.current.set(language);
    document.documentElement.lang = language;
    try { localStorage.setItem('lienza.language', language); } catch { /* Storage can be unavailable in private mode. */ }
    this.updateTitle();
  }

  t(key: string, params?: Record<string, unknown>): string {
    return this.translate.instant(key, params) as string;
  }

  errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const messages: Record<string, string> = {
      'Project name must be 1 to 100 characters long': 'errors.invalidName',
      'Version not found': 'errors.versionNotFound',
      'Project not found': 'errors.projectNotFound',
      'Project has no versions': 'errors.projectNoVersions',
      'A project with that name already exists': 'errors.duplicateProject',
      'No .fig file is open': 'errors.noFigOpen',
      'Select a .fig file': 'library.selectFigError',
    };
    if (messages[message]) return this.t(messages[message]);
    const missingNode = /^Node (.+) not found$/.exec(message);
    return missingNode ? this.t('errors.nodeNotFound', { id: missingNode[1] }) : message;
  }

  formatDate(value: string): string {
    return new Intl.DateTimeFormat(this.current() === 'es' ? 'es-ES' : 'en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(new Date(value));
  }

  formatShortDate(value: string): string {
    return new Intl.DateTimeFormat(this.current() === 'es' ? 'es-ES' : 'en-GB', {
      day: 'numeric', month: 'short', year: 'numeric'
    }).format(new Date(value));
  }

  formatSize(bytes: number): string {
    return new Intl.NumberFormat(this.current() === 'es' ? 'es-ES' : 'en-GB', {
      minimumFractionDigits: 1, maximumFractionDigits: 1
    }).format(bytes / 1024 / 1024) + ' MB';
  }

  private readSavedLanguage(): AppLanguage | null {
    try { const value = localStorage.getItem('lienza.language'); return value === 'es' || value === 'en' ? value : null; }
    catch { return null; }
  }

  private updateTitle(): void {
    const path = this.router.url.split('?')[0];
    const key = path === '/reader' ? 'titles.reader' : path === '/theme' ? 'titles.theme' : 'titles.projects';
    this.title.setTitle(this.t(key));
  }
}
