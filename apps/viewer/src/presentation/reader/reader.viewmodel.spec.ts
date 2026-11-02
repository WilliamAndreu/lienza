import { TestBed } from '@angular/core/testing';
import { ReaderActions } from '../../domain/usecases/reader-actions';
import type { Layer, NodeDetails } from '../../domain/entities/design';
import { ReaderViewModel } from './reader.viewmodel';
import { LanguageService } from '../../core/language.service';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const layer = (id: string): Layer => ({ id, name: id, type: 'FRAME', visible: true, childCount: 0 });
const details = (id: string): NodeDetails => ({ ...layer(id), x: 0, y: 0, width: 100, height: 100,
  text: null, opacity: 1, fills: [], strokes: [], layout: null, typography: null });

describe('ReaderViewModel: server synchronization', () => {
  it('ends on the latest view even while an earlier request is in flight', async () => {
    const firstView = deferred<{ viewingNodeId: string; viewingPath: Layer[] }>();
    const serverViews: string[] = [];
    const actions = {
      hitAreas: async () => [],
      view: async (id: string) => {
        serverViews.push(id);
        if (id === 'A') return firstView.promise;
        return { viewingNodeId: id, viewingPath: [layer('page'), layer(id)] };
      },
    };
    TestBed.configureTestingModule({ providers: [ReaderViewModel, { provide: ReaderActions, useValue: actions }, { provide: LanguageService, useValue: { current: () => 'es', t: (key: string) => key, errorMessage: String } }] });
    const vm = TestBed.inject(ReaderViewModel);
    vm.previewId.set('page');
    vm.activePageId.set('page');

    const first = vm.preview('A');
    await Promise.resolve();
    expect(serverViews).toEqual(['A']);
    const second = vm.preview('B');
    firstView.resolve({ viewingNodeId: 'A', viewingPath: [layer('page'), layer('A')] });
    await Promise.all([first, second]);

    expect(serverViews).toEqual(['A', 'B']);
    expect(vm.previewId()).toBe('B');
    expect(vm.viewPath().at(-1)?.id).toBe('B');
  });

  it('discards a stale selection and leaves MCP on the latest intent', async () => {
    const firstWrite = deferred<void>();
    const serverSelections: Array<string | null> = [];
    const actions = {
      details: async (id: string) => details(id),
      select: async (id: string | null) => {
        serverSelections.push(id);
        if (id === 'A') await firstWrite.promise;
      },
    };
    TestBed.configureTestingModule({ providers: [ReaderViewModel, { provide: ReaderActions, useValue: actions }, { provide: LanguageService, useValue: { current: () => 'es', t: (key: string) => key, errorMessage: String } }] });
    const vm = TestBed.inject(ReaderViewModel);

    const first = vm.select('A');
    await Promise.resolve();
    await Promise.resolve();
    expect(serverSelections).toEqual(['A']);
    const clear = vm.clearSelection();
    firstWrite.resolve();
    await Promise.all([first, clear]);

    expect(serverSelections).toEqual(['A', null]);
    expect(vm.selected()).toBeNull();
  });
});
