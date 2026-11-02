import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';

@Component({
  selector: 'app-brand-mark',
  standalone: true,
  imports: [RouterLink, TranslatePipe],
  template: `
    <a routerLink="/" class="brand-link" [attr.aria-label]="'brand.home' | translate">
      <svg class="brand-glyph" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path d="M3 11V3h8M21 3h8v8M29 21v8h-8M11 29H3v-8" stroke="currentColor" stroke-width="1.8"/>
        <path d="M10 16h12M16 10v12" stroke="currentColor" stroke-width="1.8"/>
        <circle cx="16" cy="16" r="3.25" fill="var(--fig-accent)" stroke="currentColor" stroke-width="1.5"/>
      </svg>
      <span>Lienza<span class="brand-period">.</span></span>
    </a>
  `,
  styles: [`
    .brand-link { display: inline-flex; align-items: center; gap: .55rem; color: var(--fig-ink); font-family: var(--fig-font); font-weight: 650; font-size: 1.35rem; letter-spacing: -.035em; text-decoration: none; white-space: nowrap; }
    .brand-glyph { width: 1.65rem; height: 1.65rem; flex: none; }
    .brand-period { color: #7375ad; }
  `],
})
export class BrandMark {}
