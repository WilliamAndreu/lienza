import { Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LanguageService, type AppLanguage } from '../../core/language.service';

@Component({
  selector: 'app-language-selector',
  standalone: true,
  imports: [TranslatePipe],
  template: `
    <div class="language-selector" role="group" [attr.aria-label]="'language.label' | translate">
      <button type="button" lang="es" [attr.aria-label]="'language.spanish' | translate"
        [attr.aria-pressed]="language.current() === 'es'" [class.is-active]="language.current() === 'es'"
        (click)="choose('es')">ES</button>
      <button type="button" lang="en" [attr.aria-label]="'language.english' | translate"
        [attr.aria-pressed]="language.current() === 'en'" [class.is-active]="language.current() === 'en'"
        (click)="choose('en')">EN</button>
    </div>
  `,
  styles: [`
    .language-selector { display: inline-flex; flex: none; border: 1px solid var(--fig-hairline); background: var(--fig-warm); }
    button { min-width: 44px; min-height: 44px; padding: 0 8px; color: var(--fig-muted); font: 600 12px var(--fig-font); letter-spacing: .025em; }
    button + button { border-inline-start: 1px solid var(--fig-hairline); }
    button:hover { color: var(--fig-ink); background: var(--fig-accent); }
    button.is-active { color: #fff; background: var(--fig-ink); }
    button:focus-visible { position: relative; z-index: 1; outline: 2px solid var(--fig-selection); outline-offset: 2px; }
  `]
})
export class LanguageSelector {
  readonly language = inject(LanguageService);
  choose(value: AppLanguage): void { void this.language.use(value); }
}
