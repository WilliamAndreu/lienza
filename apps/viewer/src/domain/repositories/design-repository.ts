import type { DocumentStatus, HitArea, Layer, NodeDetails } from '../entities/design';

export abstract class DesignRepository {
  abstract status(): Promise<DocumentStatus>;
  abstract open(file: File): Promise<DocumentStatus>;
  abstract tree(pageId?: string): Promise<Layer>;
  abstract details(id: string): Promise<NodeDetails>;
  abstract path(id: string): Promise<Layer[]>;
  abstract view(id: string, renderKey?: string): Promise<{ viewingNodeId: string; viewingPath: Layer[] }>;
  abstract select(id: string | null, renderKey?: string): Promise<void>;
  abstract search(query: string): Promise<Layer[]>;
  abstract hitAreas(id: string): Promise<HitArea[]>;
}
