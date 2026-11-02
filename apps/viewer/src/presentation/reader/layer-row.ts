import { Component, forwardRef, input, output, signal } from '@angular/core';
import type { Layer } from '../../domain/entities/design';
import { TranslatePipe } from '@ngx-translate/core';

@Component({
  selector: 'app-layer-row', standalone: true, imports: [forwardRef(() => LayerRow), TranslatePipe],
  template: `
    <div class="group flex min-w-0 items-center gap-1 border-b border-[#eceae5] pr-2 transition-colors duration-150 hover:bg-[#eeede8]"
      [style.background]="selectedId() === layer().id ? '#dcddf3' : null">
      <button type="button" class="flex h-9 w-5 shrink-0 items-center justify-center text-[#52595b]" [style.margin-left.px]="depth() * 13"
        [attr.aria-label]="(expanded() ? 'reader.collapseLayers' : 'reader.expandLayers') | translate" (click)="expanded.set(!expanded())">
        @if (layer().childCount) { <svg class="size-3 transition-transform" [class.rotate-90]="expanded()" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m4 2.5 4 3.5-4 3.5" stroke="currentColor" stroke-width="1.3"/></svg> }
      </button>
      <button type="button" class="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-[12px]" (click)="choose.emit(layer().id)" (dblclick)="preview.emit(layer().id)">
        <span class="w-5 shrink-0 font-mono text-[9px] font-semibold text-[#57579d]" [title]="layer().type">{{ typeCode() }}</span>
        <span class="truncate" [class.font-semibold]="selectedId() === layer().id" [style.color]="!layer().visible ? '#777b7a' : null">{{ layer().name }}</span>
      </button>
      @if (layer().childCount) { <span class="font-mono text-[10px] tabular-nums text-[#52595b]">{{ layer().childCount }}</span> }
    </div>
    @if (expanded()) {
      @for (child of layer().children ?? []; track child.id) {
        <app-layer-row [layer]="child" [depth]="depth() + 1" [selectedId]="selectedId()" (choose)="choose.emit($event)" (preview)="preview.emit($event)" />
      }
    }
  `,
})
export class LayerRow {
  readonly layer = input.required<Layer>();
  readonly depth = input(0);
  readonly selectedId = input<string | null>(null);
  readonly choose = output<string>();
  readonly preview = output<string>();
  readonly expanded = signal(false);
  typeCode() {
    const type = this.layer().type;
    return type === 'FRAME' ? 'FR' : type === 'SECTION' ? 'SC' : type === 'TEXT' ? 'TX' : type === 'VECTOR' ? 'VC' : type === 'GROUP' ? 'GR' : type === 'RECTANGLE' ? 'RC' : '·';
  }
}
