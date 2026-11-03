import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface FontFace {
  family: string;
  weight: number | 'variable';
  file: string;
}

const faces: FontFace[] = [
  { family: 'Rubik', weight: 300, file: 'Rubik/Rubik-Light.ttf' },
  { family: 'Rubik', weight: 400, file: 'Rubik/Rubik-Regular.ttf' },
  { family: 'Rubik', weight: 500, file: 'Rubik/Rubik-Medium.ttf' },
  { family: 'Rubik', weight: 700, file: 'Rubik/Rubik-Bold.ttf' },
  { family: 'Rubik', weight: 900, file: 'Rubik/Rubik-Black.ttf' },
  { family: 'Montserrat', weight: 400, file: 'Montserrat/Montserrat-Regular.ttf' },
  { family: 'Montserrat', weight: 500, file: 'Montserrat/Montserrat-Medium.ttf' },
  { family: 'Montserrat', weight: 600, file: 'Montserrat/Montserrat-SemiBold.ttf' },
  { family: 'Montserrat', weight: 700, file: 'Montserrat/Montserrat-Bold.ttf' },
  { family: 'Roboto', weight: 'variable', file: 'Roboto/Roboto-Variable.ttf' },
  { family: 'Source Sans Pro', weight: 400, file: 'SourceSansPro/SourceSansPro-Regular.ttf' },
  { family: 'Source Sans Pro', weight: 600, file: 'SourceSansPro/SourceSansPro-SemiBold.ttf' },
  { family: 'Inter', weight: 'variable', file: 'Inter/Inter-Variable.ttf' },
  { family: 'IBM Plex Sans', weight: 400, file: 'IBMPlexSans/IBMPlexSans-Regular.ttf' },
  { family: 'IBM Plex Sans', weight: 700, file: 'IBMPlexSans/IBMPlexSans-Bold.ttf' },
];

const embeddedCache = new Map<string, string>();

export function resolveFontFamily(family: string): string {
  return family === 'Raptor V3 Premium' ? 'Rubik' : family;
}

function facePath(face: FontFace): string {
  return fileURLToPath(new URL(`../assets/fonts/${face.file}`, import.meta.url));
}

function chooseFaces(svg: string): FontFace[] {
  const wanted = new Map<string, Set<number>>();
  for (const match of svg.matchAll(/font-family="([^"]+)"[^>]*font-weight="(\d+)"/g)) {
    const family = match[1]!;
    const weight = Number(match[2]!);
    if (!wanted.has(family)) wanted.set(family, new Set());
    wanted.get(family)!.add(weight);
  }
  const chosen = new Map<string, FontFace>();
  for (const [family, weights] of wanted) {
    const available = faces.filter(face => face.family === family);
    for (const weight of weights) {
      const face = available.find(item => item.weight === 'variable') ?? available.reduce<FontFace | undefined>((best, item) => {
        if (!best) return item;
        return Math.abs((item.weight as number) - weight) < Math.abs((best.weight as number) - weight) ? item : best;
      }, undefined);
      if (face) chosen.set(face.file, face);
    }
  }
  return [...chosen.values()];
}

/** Embed font bytes because an SVG loaded through <img> cannot fetch external fonts. */
export function prepareSvgFonts(svg: string): { svg: string; fontFiles: string[] } {
  if (!svg) return { svg, fontFiles: [] };
  const resolved = svg.replace(/font-family="Raptor V3 Premium"/g, 'font-family="Rubik"');
  const usedFaces = chooseFaces(resolved);
  if (!usedFaces.length) return { svg: resolved, fontFiles: [] };
  const css = usedFaces.map(face => {
    let data = embeddedCache.get(face.file);
    if (!data) {
      data = readFileSync(facePath(face)).toString('base64');
      embeddedCache.set(face.file, data);
    }
    return `@font-face{font-family:"${face.family}";font-style:normal;font-weight:${face.weight === 'variable' ? '100 900' : face.weight};src:url("data:font/ttf;base64,${data}") format("truetype")}`;
  }).join('');
  return {
    svg: resolved.replace(/(<svg\b[^>]*>)/, `$1<style type="text/css"><![CDATA[${css}]]></style>`),
    fontFiles: usedFaces.map(facePath),
  };
}
