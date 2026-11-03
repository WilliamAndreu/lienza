// Visual substitutes for ligatures in icon fonts that are not embedded in .fig files.
// The source font and ligature remain available in the parsed node and MCP data.
// Outline shapes adapted from Lucide (ISC); see assets/icons/lucide/LICENSE.
// The Apple mark comes from Simple Icons; see assets/icons/simple-icons/.
export interface IconFontFallback { markup: string; filled: boolean }

const deliverooIcons: Record<string, string> = {
  'rocket-l': '<path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09"/><path d="M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05"/>',
  briefcase: '<path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
};

const appleLogo = '<path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/>';

const missingIcon = '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 8 8 8m0-8-8 8"/>';

export function iconFontFallback(family: string | undefined, text: string, width: number, fontSize: number): IconFontFallback | undefined {
  if (!family || !/icon/i.test(family)) return undefined;
  if (family.toLowerCase() === 'icons-deliveroo') {
    if (text.trim().toLowerCase() === 'apple') return { markup: appleLogo, filled: true };
    const shape = deliverooIcons[text.trim().toLowerCase()];
    if (shape) return { markup: shape, filled: false };
  }
  // A ligature sized as one glyph must not spill its literal word over nearby text.
  return text.length > 1 && width > 0 && width <= fontSize * 1.5
    ? { markup: missingIcon, filled: false } : undefined;
}
