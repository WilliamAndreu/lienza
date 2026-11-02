import { resolve } from 'node:path';
import type { LoadedFig } from '@figma-reader/fig-engine';
import { openFigLoader } from '@figma-reader/server/fig-loader';
import { Workspace } from '@figma-reader/server/workspace';

export interface OpenDocument {
  path: string;
  workspace: Workspace;
  /** The parsed file behind the workspace, for engine calls Workspace does not expose (all images, scaled PNGs). */
  file: LoadedFig;
}

export async function openDocument(figPath: string): Promise<OpenDocument> {
  const path = resolve(figPath);
  let file: LoadedFig | undefined;
  const workspace = new Workspace({ ...openFigLoader, load: async target => (file = await openFigLoader.load(target)) });
  await workspace.open(path);
  return { path, workspace, file: file! };
}
