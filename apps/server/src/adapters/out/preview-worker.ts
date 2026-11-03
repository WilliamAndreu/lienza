import { writeFile } from 'node:fs/promises';
import { renderFigProjectPreview } from '@figma-reader/fig-engine';

const [path, output] = process.argv.slice(2);
if (!path || !output) throw new Error('Expected a .fig path and output path');
const image = await renderFigProjectPreview(path);
if (image) await writeFile(output, image);
