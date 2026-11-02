/**
 * Normalize Figma letter-spacing values to CSS pixels.
 *
 * Figma stores letterSpacing as { value, units } where units may be
 * PIXELS / PERCENT / FONT_SIZE_% (and assorted aliases).
 */

const PERCENT_UNITS = new Set([
  "PERCENT",
  "PERCENTAGE",
  "FONT_SIZE_%",
  "FONT_SIZE_PERCENT",
  "PERCENT_OF_FONT_SIZE",
]);

const PIXEL_UNITS = new Set([
  "PIXELS",
  "PIXEL",
  "UNIT_PIXELS",
  "PX",
]);

/**
 * Convert a raw letterSpacing field (number or {value, units}) into px.
 * PERCENT-family units → (value/100)*fontSize
 * PIXEL-family units → value as px
 * Bare number → treated as px
 * Unknown / missing → 0
 */
export function normalizeLetterSpacingPx(raw: unknown, fontSize: number): number {
  if (raw === null || raw === undefined) {
    return 0;
  }

  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : 0;
  }

  if (typeof raw !== "object") {
    return 0;
  }

  const record = raw as Record<string, unknown>;
  const value = record["value"];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  const unitsRaw = record["units"] ?? record["unit"] ?? record["type"];
  const units =
    typeof unitsRaw === "string" ? unitsRaw.toUpperCase().replace(/\s+/g, "_") : "";

  if (PERCENT_UNITS.has(units)) {
    const size = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 0;
    return (value / 100) * size;
  }

  if (PIXEL_UNITS.has(units) || units === "") {
    return value;
  }

  // Unknown unit string: if it looks percent-ish, treat as percent; else px
  if (units.includes("PERCENT") || units.includes("%")) {
    const size = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 0;
    return (value / 100) * size;
  }

  return value;
}
