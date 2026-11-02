import { Injectable } from '@angular/core';
import { DesignRepository } from '../../domain/repositories/design-repository';
import type { DocumentStatus, HitArea, Layer, NodeDetails } from '../../domain/entities/design';
import { readApi } from '../../core/http';

@Injectable()
export class HttpDesignRepository extends DesignRepository {
  status() { return fetch('/api/status').then(readApi<DocumentStatus>); }
  open(file: File) {
    const data = new FormData(); data.set('file', file);
    return fetch('/api/documents', { method: 'POST', body: data }).then(readApi<DocumentStatus>);
  }
  tree(pageId?: string) {
    const query = pageId ? `?pageId=${encodeURIComponent(pageId)}` : '';
    return fetch(`/api/tree${query}`).then(readApi<Layer>);
  }
  details(id: string) { return fetch(`/api/nodes/${encodeURIComponent(id)}`).then(readApi<NodeDetails>); }
  path(id: string) { return fetch(`/api/nodes/${encodeURIComponent(id)}/path`).then(readApi<Layer[]>); }
  view(id: string, renderKey?: string) { return fetch('/api/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, renderKey }) }).then(readApi<{ viewingNodeId: string; viewingPath: Layer[] }>); }
  async select(id: string | null, renderKey?: string) {
    await readApi(await fetch('/api/selection', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, renderKey }) }));
  }
  search(query: string) { return fetch(`/api/search?q=${encodeURIComponent(query)}`).then(readApi<Layer[]>); }
  hitAreas(id: string) { return fetch(`/api/hit-areas/${encodeURIComponent(id)}`).then(readApi<HitArea[]>); }
}
