import { computed, inject, Injectable, signal } from '@angular/core';
import { ReaderActions } from '../../domain/usecases/reader-actions';
import type { DocumentStatus, HitArea, Layer, NodeDetails } from '../../domain/entities/design';
import { fitCanvas, zoomCanvasAt, type CanvasTransform } from './canvas-geometry';
import { LanguageService } from '../../core/language.service';

@Injectable()
export class ReaderViewModel {
  private readonly actions = inject(ReaderActions);
  private readonly language = inject(LanguageService);
  readonly status = signal<DocumentStatus | null>(null);
  readonly tree = signal<Layer | null>(null);
  readonly selected = signal<NodeDetails | null>(null);
  readonly previewId = signal<string | null>(null);
  readonly viewPath = signal<Layer[]>([]);
  readonly hitAreas = signal<HitArea[]>([]);
  readonly searchResults = signal<Layer[]>([]);
  readonly query = signal('');
  readonly canvas = signal<CanvasTransform>({ x: 0, y: 0, zoom: 0.7 });
  readonly zoom = computed(() => this.canvas().zoom);
  readonly autoFit = signal(true);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly mobilePanel = signal<'layers' | 'canvas' | 'inspect'>('canvas');
  readonly activePageId = signal<string | null>(null);
  readonly previewUrl = computed(() => this.previewId() ? this.renderUrl(this.previewId()!) : null);
  readonly pagePreviewUrl = computed(() => this.activePageId() ? this.renderUrl(this.activePageId()!, true) : null);
  readonly showingPage = computed(() => this.previewId() === this.activePageId());
  readonly canvasBackground = computed(() => {
    if (!this.showingPage()) return '#ffffff';
    const page = this.status()?.pages.find(candidate => candidate.id === this.activePageId());
    const color = page?.backgroundEnabled !== false ? page?.backgroundColor : null;
    if (!color) return '#ffffff';
    const alpha = Math.max(0, Math.min(1, color.a * (page?.backgroundOpacity ?? 1)));
    const channel = (value: number) => Math.round(255 * (1 - alpha) + 255 * Math.max(0, Math.min(1, value)) * alpha);
    return `rgb(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)})`;
  });
  readonly visiblePages = computed(() => this.status()?.pages.filter(page => page.visible && page.childCount > 0) ?? []);
  readonly activePageName = computed(() => {
    this.language.current();
    return this.status()?.pages.find(page => page.id === this.activePageId())?.name ?? this.language.t('reader.page');
  });
  readonly selectedArea = computed(() => this.hitAreas().find(area => area.id === this.selected()?.id) ?? null);
  readonly parentView = computed(() => this.viewPath().at(-2) ?? null);
  readonly viewingLabel = computed(() => this.viewPath().at(-1)?.name ?? this.activePageName());
  readonly visibleHitAreas = computed(() => this.previewId() === this.activePageId()
    ? this.hitAreas().filter(area => area.depth === 1)
    : this.hitAreas());
  private readonly viewTransforms = new Map<string, CanvasTransform>();
  private viewIntent = 0;
  private selectionIntent = 0;
  private viewWrites: Promise<void> = Promise.resolve();
  private selectionWrites: Promise<void> = Promise.resolve();

  async initialize() {
    try {
      const status = await this.actions.status();
      this.status.set(status);
      if (status.loaded) await this.setDocument(status);
    } catch (error) { this.fail(error); }
  }

  async open(file: File) {
    if (!file.name.toLowerCase().endsWith('.fig')) { this.error.set(this.language.t('library.selectFigError')); return; }
    this.loading.set(true); this.error.set(null);
    try { await this.setDocument(await this.actions.open(file)); }
    catch (error) { this.fail(error); }
    finally { this.loading.set(false); }
  }

  private async setDocument(status: DocumentStatus) {
    this.viewTransforms.clear();
    this.status.set(status);
    const pageId = status.pages.find(page => page.visible && page.childCount > 0)?.id ?? status.pages[0]?.id ?? null;
    this.activePageId.set(pageId);
    this.previewId.set(pageId);
    this.hitAreas.set([]);
    const viewIntent = ++this.viewIntent;
    const selectionIntent = ++this.selectionIntent;
    this.autoFit.set(true);
    this.selected.set(null);
    this.query.set(''); this.searchResults.set([]);
    this.mobilePanel.set('canvas');
    const [tree, view, areas] = await Promise.all([
      pageId ? this.actions.tree(pageId) : Promise.resolve(null),
      pageId ? this.queueView(pageId, viewIntent) : Promise.resolve(null),
      pageId ? this.actions.hitAreas(pageId) : Promise.resolve([]),
      this.queueSelection(null, selectionIntent),
    ]);
    if (this.status()?.renderKey !== status.renderKey) return;
    this.tree.set(tree);
    this.viewPath.set(view?.viewingPath ?? []);
    this.hitAreas.set(areas);
  }

  async changePage(pageId: string) {
    try {
      this.activePageId.set(pageId);
      const clearSelection = this.clearSelection();
      const preview = this.preview(pageId);
      const [tree] = await Promise.all([this.actions.tree(pageId), clearSelection, preview]);
      if (this.activePageId() === pageId) this.tree.set(tree);
    } catch (error) { this.fail(error); }
  }

  async preview(id: string) {
    try {
      if (this.previewId() === id) return;
      const viewIntent = ++this.viewIntent;
      const previous = this.previewId();
      if (previous && previous !== id) this.viewTransforms.set(previous, this.canvas());
      this.previewId.set(id);
      this.hitAreas.set([]);
      const restored = this.viewTransforms.get(id);
      if (restored) this.canvas.set(restored);
      this.autoFit.set(!restored);
      const [areas, view] = await Promise.all([this.actions.hitAreas(id), this.queueView(id, viewIntent)]);
      if (this.previewId() !== id || viewIntent !== this.viewIntent || !view) return;
      this.hitAreas.set(areas);
      this.viewPath.set(view.viewingPath);
      const pageId = view.viewingPath[0]?.id;
      if (pageId && pageId !== this.activePageId()) {
        this.activePageId.set(pageId);
        this.tree.set(await this.actions.tree(pageId));
      }
      this.mobilePanel.set('canvas');
    } catch (error) { this.fail(error); }
  }

  async select(id: string) {
    const selectionIntent = ++this.selectionIntent;
    try {
      const details = await this.actions.details(id);
      if (selectionIntent !== this.selectionIntent) return undefined;
      await this.queueSelection(id, selectionIntent);
      if (selectionIntent !== this.selectionIntent) return undefined;
      this.selected.set(details);
      return details;
    } catch (error) { this.fail(error); return undefined; }
  }

  async clearSelection() {
    const selectionIntent = ++this.selectionIntent;
    this.selected.set(null);
    try { await this.queueSelection(null, selectionIntent); }
    catch (error) { this.fail(error); }
  }

  private queueView(id: string, intent: number) {
    const renderKey = this.status()?.renderKey;
    const request = this.viewWrites.then(() => intent === this.viewIntent ? this.actions.view(id, renderKey) : null);
    this.viewWrites = request.then(() => undefined, () => undefined);
    return request;
  }

  private queueSelection(id: string | null, intent: number) {
    const renderKey = this.status()?.renderKey;
    const request = this.selectionWrites.then(() => intent === this.selectionIntent ? this.actions.select(id, renderKey) : undefined);
    this.selectionWrites = request.then(() => undefined, () => undefined);
    return request;
  }

  path(id: string) { return this.actions.path(id); }

  async search(query: string) {
    this.query.set(query);
    if (!query.trim()) { this.searchResults.set([]); return; }
    try { this.searchResults.set(await this.actions.search(query)); }
    catch (error) { this.fail(error); }
  }

  zoomAt(nextZoom: number, anchorX: number, anchorY: number) {
    this.autoFit.set(false);
    this.canvas.update(current => zoomCanvasAt(current, nextZoom, anchorX, anchorY));
  }
  panBy(dx: number, dy: number) {
    this.autoFit.set(false);
    this.canvas.update(current => ({ ...current, x: current.x + dx, y: current.y + dy }));
  }
  setCanvas(transform: CanvasTransform) {
    this.autoFit.set(false);
    this.canvas.set(transform);
  }
  fitZoom(imageWidth: number, imageHeight: number, viewportWidth: number, viewportHeight: number, force = false) {
    if (!force && !this.autoFit()) return;
    this.canvas.set(fitCanvas(imageWidth, imageHeight, viewportWidth, viewportHeight));
    this.autoFit.set(true);
  }
  dismissError() { this.error.set(null); }
  private renderUrl(id: string, transparentCanvas = false) {
    return `/api/render/${encodeURIComponent(id)}.svg?v=${encodeURIComponent(this.status()?.renderKey ?? '')}${transparentCanvas ? '&canvasBackground=none' : ''}`;
  }
  private fail(error: unknown) { this.error.set(this.language.errorMessage(error)); }
}
