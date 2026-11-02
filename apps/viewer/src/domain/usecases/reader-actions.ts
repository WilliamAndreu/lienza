import { inject, Injectable } from '@angular/core';
import { DesignRepository } from '../repositories/design-repository';

@Injectable({ providedIn: 'root' })
export class ReaderActions {
  private readonly repository = inject(DesignRepository);
  status() { return this.repository.status(); }
  open(file: File) { return this.repository.open(file); }
  tree(pageId?: string) { return this.repository.tree(pageId); }
  details(id: string) { return this.repository.details(id); }
  path(id: string) { return this.repository.path(id); }
  view(id: string, renderKey?: string) { return this.repository.view(id, renderKey); }
  select(id: string | null, renderKey?: string) { return this.repository.select(id, renderKey); }
  search(query: string) { return this.repository.search(query); }
  hitAreas(id: string) { return this.repository.hitAreas(id); }
}
