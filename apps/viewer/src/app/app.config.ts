import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideTranslateService } from '@ngx-translate/core';
import { provideTranslateHttpLoader } from '@ngx-translate/http-loader';

import { routes } from './app.routes';
import { DesignRepository } from '../domain/repositories/design-repository';
import { HttpDesignRepository } from '../data/repositories/http-design-repository';
import { ProjectRepository } from '../domain/repositories/project-repository';
import { HttpProjectRepository } from '../data/repositories/http-project-repository';
import { LanguageService } from '../core/language.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(),
    provideTranslateService({ fallbackLang: 'es', loader: provideTranslateHttpLoader({ prefix: '/i18n/', suffix: '.json' }) }),
    provideAppInitializer(() => inject(LanguageService).initialize()),
    { provide: DesignRepository, useClass: HttpDesignRepository },
    { provide: ProjectRepository, useClass: HttpProjectRepository }
  ]
};
