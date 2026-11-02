import { Routes } from '@angular/router';
import { ReaderView } from '../presentation/reader/reader-view';
import { ProjectLibraryView } from '../presentation/projects/project-library-view';
import { ThemeView } from '../presentation/theme/theme-view';

export const routes: Routes = [
  { path: '', component: ProjectLibraryView },
  { path: 'reader', component: ReaderView },
  { path: 'theme', component: ThemeView },
  { path: '**', redirectTo: '' },
];
