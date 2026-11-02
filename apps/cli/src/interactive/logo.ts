import { createRequire } from 'node:module';
import { colorOn, rgb, style } from './format.js';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

// The viewer's brand glyph (crop marks, crosshair, periwinkle center) and the "Lienza." wordmark.
const GLYPH = [
  '┌──       ──┐',
  '      │      ',
  '   ───●───   ',
  '      │      ',
  '└──       ──┘',
];
const WORDMARK = [
  '█   █ █▀▀ █▄  █ ▀▀█ ▄▀▄  ',
  '█   █ █▀▀ █ ▀▄█ ▄▀  █▀█  ',
  '█▄▄ █ █▄▄ █   █ █▄▄ █ █ ▄',
];
const ANNOTATION = '#7375AD';

export function logo() {
  if (!colorOn()) return `Lienza ${version} · local Figma reader`;
  const glyph = GLYPH.map(line => {
    const [before, after] = line.split('●');
    return after === undefined ? style.gray(line) : `${style.gray(before!)}${rgb(ANNOTATION)('●')}${style.gray(after)}`;
  });
  const word = WORDMARK.map(line => style.bold(line.slice(0, -1)) + rgb(ANNOTATION)(line.slice(-1)));
  const right = ['', ...word, style.gray(`local Figma reader · v${version}`)];
  return glyph.map((line, index) => `  ${line}   ${right[index]}`).join('\n');
}
