import { Component, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { ThemeReport } from '../../domain/entities/theme';
import { readApi } from '../../core/http';
import { BrandMark } from '../shared/brand-mark';
import { LanguageSelector } from '../shared/language-selector';
import { LanguageService } from '../../core/language.service';
import { inject } from '@angular/core';

@Component({
  selector: 'app-theme-view',
  standalone: true,
  imports: [RouterLink, BrandMark, LanguageSelector, TranslatePipe],
  templateUrl: './theme-view.html',
})
export class ThemeView implements OnInit {
  readonly language = inject(LanguageService);
  readonly Math = Math;
  readonly theme = signal<ThemeReport | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly showAllColors = signal(false);
  readonly showAllStyles = signal(false);
  readonly copied = signal(false);

  ngOnInit() { void this.load(); }

  async load() {
    this.loading.set(true);
    this.error.set(null);
    try { this.theme.set(await fetch('/api/theme').then(readApi<ThemeReport>)); }
    catch (error) { this.error.set(this.language.errorMessage(error)); }
    finally { this.loading.set(false); }
  }

  colors(theme: ThemeReport) { return this.showAllColors() ? theme.colors : theme.colors.slice(0, 24); }
  styles(theme: ThemeReport) { return this.showAllStyles() ? theme.typography.styles : theme.typography.styles.slice(0, 12); }
  colorRole(color: ThemeReport['colors'][number]) {
    const roles = [color.text && this.language.t('common.text'), color.fills && this.language.t('common.fill'), color.strokes && this.language.t('common.border'), color.backgrounds && this.language.t('common.background')].filter(Boolean);
    return roles.join(' · ');
  }
  borderAlign(align: string): string {
    const key = align === 'INSIDE' ? 'theme.alignInside' : align === 'OUTSIDE' ? 'theme.alignOutside' : align === 'CENTER' ? 'theme.alignCenter' : null;
    return key ? this.language.t(key) : align;
  }
  localizeNote(note: string): string {
    const notes: Record<string, string> = {
      'Values observed in visible layers are not declared Figma variables.': 'theme.noteObserved',
      'Spacing combines declared Auto Layout values and geometry between sibling layers.': 'theme.noteMixedSpacing',
      'Spacing is inferred from geometry between sibling layers; validate it before using it as tokens.': 'theme.noteInferredSpacing',
      'Colors inside raster images are not included.': 'theme.noteRaster',
      'In typography.fonts, declaredFamily is the family specified by the .fig; renderedFamily identifies only the configured preview substitute. Use declaredFamily when implementing the design.': 'theme.noteFonts',
    };
    return notes[note] ? this.language.t(notes[note]) : note;
  }
  scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }
  async copyCss(css: string) {
    try { await navigator.clipboard.writeText(css); this.copied.set(true); setTimeout(() => this.copied.set(false), 1800); }
    catch { this.copied.set(false); }
  }
}
