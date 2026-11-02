import { Component, computed, effect, ElementRef, HostListener, inject, OnDestroy, OnInit, ViewChild, signal } from '@angular/core';
import { NgStyle } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { LayerRow } from './layer-row';
import { ReaderViewModel } from './reader.viewmodel';
import type { HitArea } from '../../domain/entities/design';
import { focusCanvasOnArea, zoomCanvasAt, type CanvasTransform } from './canvas-geometry';
import { BrandMark } from '../shared/brand-mark';
import { LanguageSelector } from '../shared/language-selector';
import { LanguageService } from '../../core/language.service';
import { ProjectActions } from '../../domain/usecases/project-actions';
import type { DesignProject, DesignVersion } from '../../domain/entities/project';

interface Point { x: number; y: number }
interface PinchStart { distance: number; center: Point; canvas: CanvasTransform }
const GESTURE_ZOOM_SENSITIVITY = 1.65;

@Component({
  selector: 'app-reader-view', standalone: true, imports: [LayerRow, NgStyle, RouterLink, BrandMark, LanguageSelector, TranslatePipe], providers: [ReaderViewModel],
  templateUrl: './reader-view.html',
})
export class ReaderView implements OnInit, OnDestroy {
  readonly language = inject(LanguageService);
  @ViewChild('canvasViewport') set viewportElement(element: ElementRef<HTMLElement> | undefined) {
    this.viewportObserver?.disconnect();
    this.canvasViewport = element;
    if (element && typeof ResizeObserver !== 'undefined') {
      this.viewportObserver = new ResizeObserver(() => this.fitPreview());
      this.viewportObserver.observe(element.nativeElement);
    }
  }
  private canvasViewport?: ElementRef<HTMLElement>;
  readonly vm: ReaderViewModel;
  readonly previewWidth = signal(1000);
  readonly previewHeight = signal(700);
  readonly pageWidth = signal(1000);
  readonly pageHeight = signal(700);
  readonly copied = signal(false);
  readonly dragging = signal(false);
  readonly spaceHeld = signal(false);
  readonly overCanvas = signal(false);
  readonly focusedId = signal<string | null>(null);
  readonly activeVersion = signal<{ project: DesignProject; version: DesignVersion } | null>(null);
  readonly mobileDetailStart = signal(false);
  readonly inspectorCollapsed = signal(true);
  private readonly route = inject(ActivatedRoute);
  private readonly projects = inject(ProjectActions);
  private readonly mobileStartedPages = new Set<string>();
  private readonly loadedPreviewUrl = signal<string | null>(null);
  private readonly loadedPageUrl = signal<string | null>(null);
  readonly renderReady = computed(() => this.vm.showingPage()
    ? this.loadedPageUrl() === this.absoluteUrl(this.vm.pagePreviewUrl())
    : this.loadedPreviewUrl() === this.absoluteUrl(this.vm.previewUrl()));
  private previewImage: HTMLImageElement | null = null;
  private pageImage: HTMLImageElement | null = null;
  private readonly pointers = new Map<number, Point>();
  private dragPointerId: number | null = null;
  private dragLast: Point | null = null;
  private pinchStart: PinchStart | null = null;
  private nativeGestureZoom: number | null = null;
  private gestureMoved = false;
  private dragDistance = 0;
  private ignoreClickUntil = 0;
  private pendingFocusId: string | null = null;
  private hitSampleCanvas: HTMLCanvasElement | null = null;
  private viewportObserver: ResizeObserver | null = null;

  constructor(vm: ReaderViewModel) {
    this.vm = vm;
    effect(() => {
      if (this.renderReady() && this.vm.showingPage() && this.vm.hitAreas().length) {
        queueMicrotask(() => this.tryMobileDetailStart());
      }
    });
    effect(() => {
      this.inspectorCollapsed.set(!this.vm.selected());
    });
  }
  ngOnDestroy() { this.viewportObserver?.disconnect(); }
  async ngOnInit() {
    const catalog = this.projects.list().then(value => {
      const project = value.projects.find(item => item.id === value.activeProjectId);
      const version = project?.versions.find(item => item.id === value.activeVersionId);
      this.activeVersion.set(project && version ? { project, version } : null);
    }).catch(() => this.activeVersion.set(null));
    await this.vm.initialize();
    await catalog;
    const layerId = this.route.snapshot.queryParamMap.get('layer');
    if (layerId && this.vm.status()?.loaded) await this.openLayer(layerId);
  }
  onImageLoad(event: Event) {
    const image = event.target as HTMLImageElement;
    if (image.currentSrc !== this.absoluteUrl(this.vm.previewUrl())) return;
    this.previewImage = image;
    this.previewWidth.set(image.naturalWidth || 1000);
    this.previewHeight.set(image.naturalHeight || 700);
    this.loadedPreviewUrl.set(image.currentSrc);
    this.fitPreview();
    this.tryPendingFocus();
  }
  onPageImageLoad(event: Event) {
    const image = event.target as HTMLImageElement;
    if (image.currentSrc !== this.absoluteUrl(this.vm.pagePreviewUrl())) return;
    this.pageImage = image;
    this.pageWidth.set(image.naturalWidth || 1000);
    this.pageHeight.set(image.naturalHeight || 700);
    this.loadedPageUrl.set(image.currentSrc);
    if (this.vm.showingPage()) {
      this.previewWidth.set(this.pageWidth());
      this.previewHeight.set(this.pageHeight());
      this.fitPreview();
      this.tryMobileDetailStart();
    }
    this.tryPendingFocus();
  }
  viewPage(pageId: string) {
    this.focusedId.set(null);
    this.mobileDetailStart.set(false);
    this.pendingFocusId = null;
    void this.vm.preview(pageId);
    if (this.renderReady() && this.pageImage?.complete && this.pageImage.naturalWidth) {
      this.previewWidth.set(this.pageWidth());
      this.previewHeight.set(this.pageHeight());
      this.fitPreview();
    }
  }
  changePage(pageId: string) {
    this.focusedId.set(null);
    this.mobileDetailStart.set(false);
    this.pendingFocusId = null;
    void this.vm.changePage(pageId);
  }
  navigateTo(id: string) {
    this.focusedId.set(null);
    this.mobileDetailStart.set(false);
    this.pendingFocusId = null;
    void this.vm.preview(id);
  }
  resetFocus() {
    this.focusedId.set(null);
    this.mobileDetailStart.set(false);
    this.fitPreview(true);
  }
  private tryMobileDetailStart() {
    const pageId = this.vm.activePageId();
    const viewport = this.canvasViewport?.nativeElement;
    if (!pageId || !viewport || !window.matchMedia('(max-width: 767px)').matches || !this.vm.showingPage()
      || !this.renderReady() || !this.vm.autoFit() || this.mobileStartedPages.has(pageId)) return;
    const firstView = this.vm.visibleHitAreas()
      .filter(area => area.width > 24 && area.height > 24)
      .sort((a, b) => a.y - b.y || a.x - b.x)[0];
    if (!firstView) return;
    const zoom = Math.max(this.vm.zoom(), 0.65);
    this.mobileStartedPages.add(pageId);
    this.vm.setCanvas({
      zoom,
      x: 18 - firstView.x * zoom,
      y: 88 - firstView.y * zoom,
    });
    this.mobileDetailStart.set(true);
  }
  async openLayer(id: string) {
    this.mobileDetailStart.set(false);
    const details = await this.vm.select(id);
    if (!details) return;
    if (!details.visible) { this.vm.error.set(this.language.t('reader.hiddenLayer')); return; }
    if (details.childCount > 0) { this.navigateTo(id); return; }
    if (this.focusArea(id)) return;
    try {
      const path = await this.vm.path(id);
      const parent = path.at(-2);
      if (!parent) return;
      this.pendingFocusId = id;
      await this.vm.preview(parent.id);
      if (this.pendingFocusId && !this.tryPendingFocus()) {
        this.pendingFocusId = null;
        this.vm.error.set(this.language.t('reader.layerNotFound'));
      }
    } catch (error) {
      this.pendingFocusId = null;
      this.vm.error.set(error instanceof Error ? error.message : String(error));
    }
  }
  isolateSelected() {
    const id = this.vm.selected()?.id;
    if (!id) return;
    this.focusedId.set(null);
    this.pendingFocusId = null;
    void this.vm.preview(id);
  }
  private focusArea(id: string) {
    const area = this.vm.hitAreas().find(candidate => candidate.id === id);
    const viewport = this.canvasViewport?.nativeElement;
    if (!area || !viewport || !viewport.clientWidth || !viewport.clientHeight) return false;
    this.vm.setCanvas(focusCanvasOnArea(this.vm.canvas(), area, viewport.clientWidth, viewport.clientHeight));
    this.focusedId.set(id);
    return true;
  }
  private tryPendingFocus() {
    if (this.pendingFocusId && this.focusArea(this.pendingFocusId)) { this.pendingFocusId = null; return true; }
    return false;
  }
  @HostListener('window:resize') onResize() { this.fitPreview(); }
  fitPreview(force = false) {
    if (!this.renderReady()) return;
    const image = this.vm.showingPage() ? this.pageImage : this.previewImage;
    const viewport = image?.closest('.canvas-viewport');
    if (image && viewport && viewport.clientWidth > 0 && viewport.clientHeight > 0) {
      this.vm.fitZoom(image.naturalWidth, image.naturalHeight, viewport.clientWidth, viewport.clientHeight, force);
    }
  }
  zoomBy(factor: number) {
    const viewport = (this.vm.showingPage() ? this.pageImage : this.previewImage)?.closest('.canvas-viewport');
    if (!viewport) return;
    this.vm.zoomAt(this.vm.zoom() * factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
  }
  onCanvasWheel(event: WheelEvent) {
    event.preventDefault();
    const viewport = event.currentTarget as HTMLElement;
    const rect = viewport.getBoundingClientRect();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
    const dx = event.deltaX * unit;
    const dy = event.deltaY * unit;
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-dy * 0.002 * GESTURE_ZOOM_SENSITIVITY);
      this.vm.zoomAt(this.vm.zoom() * factor, event.clientX - rect.left, event.clientY - rect.top);
    } else {
      this.vm.panBy(-(event.shiftKey && !dx ? dy : dx), -(event.shiftKey && !dx ? 0 : dy));
    }
  }
  onCanvasPointerDown(event: PointerEvent) {
    const viewport = event.currentTarget as HTMLElement;
    const point = this.localPoint(event, viewport);
    if (event.pointerType === 'touch') {
      this.pointers.set(event.pointerId, point);
      if (this.pointers.size === 2) {
        this.pinchStart = this.makePinchStart();
        this.gestureMoved = true;
        this.dragging.set(true);
      } else if (this.pointers.size === 1) {
        this.dragPointerId = event.pointerId;
        this.dragLast = point;
        this.gestureMoved = false;
        this.dragDistance = 0;
      }
      return;
    }
    if (event.button !== 1 && !(event.button === 0 && this.spaceHeld())) return;
    event.preventDefault();
    viewport.setPointerCapture(event.pointerId);
    this.dragPointerId = event.pointerId;
    this.dragLast = point;
    this.gestureMoved = false;
    this.dragDistance = 0;
    this.dragging.set(true);
  }
  onCanvasPointerMove(event: PointerEvent) {
    const viewport = event.currentTarget as HTMLElement;
    const point = this.localPoint(event, viewport);
    if (event.pointerType === 'touch' && this.pointers.has(event.pointerId)) {
      this.pointers.set(event.pointerId, point);
      if (this.pinchStart && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const center = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
        const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        const start = this.pinchStart;
        const next = zoomCanvasAt(start.canvas, start.canvas.zoom * Math.pow(distance / start.distance, GESTURE_ZOOM_SENSITIVITY), start.center.x, start.center.y);
        this.vm.setCanvas({ ...next, x: next.x + center.x - start.center.x, y: next.y + center.y - start.center.y });
        return;
      }
    }
    if (this.dragPointerId !== event.pointerId || !this.dragLast) return;
    const dx = point.x - this.dragLast.x;
    const dy = point.y - this.dragLast.y;
    if (Math.abs(dx) + Math.abs(dy) > 0) {
      this.vm.panBy(dx, dy);
      this.dragLast = point;
      this.dragDistance += Math.hypot(dx, dy);
      if (this.dragDistance > 4) this.gestureMoved = true;
      this.dragging.set(true);
    }
  }
  onCanvasPointerUp(event: PointerEvent) {
    if (event.pointerType === 'touch') {
      this.pointers.delete(event.pointerId);
      this.pinchStart = this.pointers.size >= 2 ? this.makePinchStart() : null;
      const remaining = this.pointers.entries().next().value as [number, Point] | undefined;
      this.dragPointerId = remaining?.[0] ?? null;
      this.dragLast = remaining?.[1] ?? null;
      this.dragging.set(this.pointers.size > 0);
    } else if (this.dragPointerId === event.pointerId) {
      this.dragPointerId = null;
      this.dragLast = null;
      this.dragging.set(false);
    }
    if (this.gestureMoved) this.ignoreClickUntil = performance.now() + 250;
    if (this.pointers.size === 0 && this.dragPointerId === null) this.gestureMoved = false;
  }
  onHitAreaClick(event: MouseEvent, id: string) {
    if (this.spaceHeld() || performance.now() < this.ignoreClickUntil) { event.preventDefault(); return; }
    if (!this.isPaintedAt(event.clientX, event.clientY)) { event.preventDefault(); return; }
    event.stopPropagation();
    void this.vm.select(id);
  }
  onHitAreaDoubleClick(event: MouseEvent, id: string) {
    if (this.spaceHeld() || performance.now() < this.ignoreClickUntil) { event.preventDefault(); return; }
    if (!this.isPaintedAt(event.clientX, event.clientY)) { event.preventDefault(); return; }
    event.stopPropagation();
    void this.openLayer(id);
  }
  onCanvasClick() {
    if (this.spaceHeld() || performance.now() < this.ignoreClickUntil) return;
    void this.vm.clearSelection();
  }
  onHitAreaPointerMove(event: PointerEvent) {
    (event.currentTarget as HTMLElement).classList.toggle('painted-hit', this.isPaintedAt(event.clientX, event.clientY));
  }
  onHitAreaPointerLeave(event: PointerEvent) {
    (event.currentTarget as HTMLElement).classList.remove('painted-hit');
  }
  /** Bounding boxes remain useful for focus, but blank pixels must not capture clicks. */
  private isPaintedAt(clientX: number, clientY: number): boolean {
    if (!this.renderReady()) return false;
    const image = this.vm.showingPage() ? this.pageImage : this.previewImage;
    const viewport = this.canvasViewport?.nativeElement;
    if (!image?.complete || !image.naturalWidth || !viewport) return true;
    const rect = viewport.getBoundingClientRect();
    const canvas = this.vm.canvas();
    const sourceX = (clientX - rect.left - canvas.x) / canvas.zoom;
    const sourceY = (clientY - rect.top - canvas.y) / canvas.zoom;
    if (sourceX < 0 || sourceY < 0 || sourceX >= image.naturalWidth || sourceY >= image.naturalHeight) return false;

    // The interactive page SVG is transparent; the page color belongs to the viewport.
    const background = [0, 0, 0, 0];
    const radius = Math.max(1, Math.ceil(2 / canvas.zoom));
    const x = Math.max(0, Math.floor(sourceX) - radius);
    const y = Math.max(0, Math.floor(sourceY) - radius);
    const width = Math.min(image.naturalWidth - x, radius * 2 + 1);
    const height = Math.min(image.naturalHeight - y, radius * 2 + 1);
    this.hitSampleCanvas ??= document.createElement('canvas');
    this.hitSampleCanvas.width = width;
    this.hitSampleCanvas.height = height;
    const context = this.hitSampleCanvas.getContext('2d', { willReadFrequently: true });
    if (!context) return true;
    try {
      context.clearRect(0, 0, width, height);
      context.drawImage(image, x, y, width, height, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if ([0, 1, 2, 3].some(channel => Math.abs(pixels[offset + channel]! - background[channel]!) > 3)) return true;
      }
      return false;
    } catch {
      // A browser may disallow reading an SVG with external assets. Keep selection usable.
      return true;
    }
  }
  onNativeGestureStart(event: Event) {
    event.preventDefault();
    this.nativeGestureZoom = this.vm.zoom();
  }
  onNativeGesture(event: Event) {
    event.preventDefault();
    if (this.pointers.size >= 2 || this.nativeGestureZoom === null) return;
    const gesture = event as Event & { scale?: number; clientX?: number; clientY?: number };
    const viewport = event.currentTarget as HTMLElement;
    const rect = viewport.getBoundingClientRect();
    const x = gesture.clientX === undefined ? rect.width / 2 : gesture.clientX - rect.left;
    const y = gesture.clientY === undefined ? rect.height / 2 : gesture.clientY - rect.top;
    this.vm.zoomAt(this.nativeGestureZoom * Math.pow(gesture.scale ?? 1, GESTURE_ZOOM_SENSITIVITY), x, y);
  }
  onNativeGestureEnd(event: Event) { event.preventDefault(); this.nativeGestureZoom = null; }
  @HostListener('window:keydown', ['$event']) onKeyDown(event: KeyboardEvent) {
    if (event.code !== 'Space' || event.repeat || !this.overCanvas()) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, button, [contenteditable="true"]')) return;
    this.spaceHeld.set(true);
    event.preventDefault();
  }
  @HostListener('window:keyup', ['$event']) onKeyUp(event: KeyboardEvent) {
    if (event.code === 'Space') this.spaceHeld.set(false);
  }
  @HostListener('window:blur') onWindowBlur() {
    this.spaceHeld.set(false);
    this.dragging.set(false);
    this.pointers.clear();
    this.dragPointerId = null;
    this.dragLast = null;
    this.pinchStart = null;
  }
  private localPoint(event: PointerEvent, viewport: HTMLElement): Point {
    const rect = viewport.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  private makePinchStart(): PinchStart {
    const [a, b] = [...this.pointers.values()];
    return {
      distance: Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y)),
      center: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 },
      canvas: this.vm.canvas(),
    };
  }
  async copyMcp() {
    const url = `${window.location.protocol}//${window.location.hostname}:3210/mcp`;
    try { await navigator.clipboard.writeText(url); this.copied.set(true); setTimeout(() => this.copied.set(false), 1800); }
    catch { this.copied.set(false); }
  }
  areaStyle(area: HitArea) {
    return {
      left: `${area.x}px`,
      top: `${area.y}px`,
      width: `${area.width}px`,
      height: `${area.height}px`,
      zIndex: `${Math.min(area.depth, 100)}`,
    };
  }
  private absoluteUrl(url: string | null): string | null {
    return url ? new URL(url, window.location.href).href : null;
  }
  paintColor(paint: unknown): string | null {
    if (!paint || typeof paint !== 'object') return null;
    const color = (paint as { color?: { r?: number; g?: number; b?: number; a?: number } }).color;
    if (!color) return null;
    const channel = (value: number | undefined) => Math.round(Math.max(0, Math.min(1, value ?? 0)) * 255).toString(16).padStart(2, '0');
    return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`.toUpperCase();
  }
  clampText(value: string | null) { return value && value.length > 300 ? `${value.slice(0, 300)}…` : value; }
}
