import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { ProjectActions } from '../domain/usecases/project-actions';
import { ProjectLibraryView } from '../presentation/projects/project-library-view';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App, ProjectLibraryView],
      providers: [
        provideRouter([]),
        provideTranslateService({ lang: 'es' }),
        { provide: ProjectActions, useValue: { list: async () => ({ projects: [], activeProjectId: null, activeVersionId: null }) } },
      ],
    }).compileComponents();
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('es', { library: { titleFirst: 'Archivo de', titleSecond: 'diseños.' } });
    translate.use('es');
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('shows the project library and the .fig upload entry point', async () => {
    const fixture = TestBed.createComponent(ProjectLibraryView);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
    expect(compiled.querySelector('h1')?.textContent).toContain('Archivo de');
    expect(compiled.querySelector('input[type="file"]')).toBeTruthy();
  });
});
