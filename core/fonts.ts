/**
 * The figlets — kona's display typefaces, and the sizing math around them.
 *
 * A `big` node is drawn in one of OpenTUI's seven ASCII fonts, and which one is
 * a THEME decision (`theme().font`, see core/config.ts): the figlet is the
 * typeface of every hero kona draws — the timer countdown, the clock hero, the
 * `kona` wordmark — so a theme that only swapped colors would only be doing
 * half the job.
 *
 * Fonts differ enormously in size: "00:00" is 17 cells wide in `tiny` and 60 in
 * `huge`, which is wider than most terminals. So the font a theme names is a
 * PREFERENCE, and `fitBigFont` is what turns it into a font that actually fits
 * the pane it is about to be drawn in.
 *
 * The metrics below are a copy of OpenTUI's, not a call into it: this module is
 * imported by the config, which is imported by the CLI, and pulling
 * `@opentui/core` in for a width would cost every `kona call` a third of a
 * second of import time for a table that fits on a screen. tests/fonts.test.ts
 * measures every character against `measureText()` so the copy cannot drift.
 */

/** Every figlet the host can draw, widest-looking first. */
export const BIG_FONTS = ["block", "tiny", "slick", "shade", "huge", "grid", "pallet"] as const;

/** ASCII-art fonts the host can render for a `big` node. */
export type BigFont = (typeof BIG_FONTS)[number];

/** The figlet a theme gets when it doesn't name one. kona's own. */
export const DEFAULT_FONT: BigFont = "block";

/**
 * Character widths, grouped by width so the table stays readable: `8:
 * "2345…"` means every one of those characters is 8 cells wide in that font.
 * Heights are uniform per font (a figlet's whole point), and every font puts
 * exactly one blank column between characters.
 */
const METRICS: Record<BigFont, { lines: number; widths: Record<number, string> }> = {
  block: {
    lines: 6,
    widths: {
      3: "I!.:;,' ",
      4: "1()",
      5: '"',
      6: "-",
      7: "+=%/",
      8: "2345789ABCDEFHJKLPRSXZ?_$",
      9: "06GOQTUVY@#&",
      10: "NW",
      11: "M",
    },
  },
  tiny: {
    lines: 2,
    widths: {
      1: "I!.:,' ",
      2: "125Z?-_=();",
      3: '0346789ABCDEFGHJKLOPQRSTUVXY+@#$&"',
      4: "N%/",
      5: "MW",
    },
  },
  slick: {
    lines: 6,
    widths: {
      2: "!.:;,'",
      3: " ",
      4: '1IJ+-_"',
      5: "023456789ABCDEFGHKLOPRSU?=$&()",
      6: "MNQTVWXYZ#",
      7: "@%/",
    },
  },
  shade: {
    lines: 8,
    widths: {
      3: "ITY ",
      4: "0123456789ABCDEFGHJKLMNOPQRSUWXZ!?.+-_=@#$%()/:;,'",
      5: "V&",
      6: '"',
    },
  },
  huge: {
    lines: 11,
    widths: {
      3: "'",
      4: "!.:;, ",
      6: '"',
      7: "-_=",
      8: "K()",
      9: "Z",
      10: "+",
      11: "X%/",
      13: "0123456789ABCDEFGHIJLMNOPQRSTUWY?$&",
      14: "@",
      17: "#",
      19: "V",
    },
  },
  grid: {
    lines: 6,
    widths: {
      2: "I!.:;,' ",
      3: "JLR",
      4: '1ABCDEFGHKMNOPQSTUVX+-_$"',
      5: "023456789YZ?=&()",
      6: "W",
      7: "@#%/",
    },
  },
  pallet: {
    lines: 6,
    widths: {
      2: "!.:;,'",
      3: " ",
      4: '1IJ+-_"',
      5: "023456789ABCDEFGHKLOPRSU?=$&()",
      6: "MNQTVWXYZ",
      7: "@#%/",
    },
  },
};

/** Blank columns between two characters. The same in every font kona ships. */
const LETTERSPACE = 1;

/** char -> width, per font. Built once from the grouped table above. */
const WIDTHS: Record<BigFont, Map<string, number>> = Object.fromEntries(
  BIG_FONTS.map((font) => [
    font,
    new Map(
      Object.entries(METRICS[font].widths).flatMap(([w, chars]) =>
        [...chars].map((c) => [c, Number(w)] as const),
      ),
    ),
  ]),
) as Record<BigFont, Map<string, number>>;

/** Is this a font the host can draw? Guards config and verb arguments. */
export function isBigFont(value: unknown): value is BigFont {
  return typeof value === "string" && (BIG_FONTS as readonly string[]).includes(value);
}

/** Lines a font draws, whatever the text — the figlet's fixed height. */
export function fontLines(font: BigFont): number {
  return METRICS[font].lines;
}

/**
 * The cell box a string occupies in a font. Mirrors OpenTUI's own measurement:
 * lowercase is drawn as uppercase, a character the font doesn't have is drawn
 * as a space, and one blank column separates each pair.
 */
export function bigSize(text: string, font: BigFont): { width: number; height: number } {
  const widths = WIDTHS[font];
  const space = widths.get(" ") ?? 1;
  const chars = [...text];
  let width = 0;
  for (const ch of chars) width += widths.get(ch.toUpperCase()) ?? space;
  if (chars.length > 1) width += LETTERSPACE * (chars.length - 1);
  return { width, height: chars.length ? METRICS[font].lines : 0 };
}

/** Limits a hero has to live inside. Omit one and it isn't checked. */
export interface FontLimits {
  width?: number;
  height?: number;
}

/** Would this text, in this font, fit the pane? */
export function bigFits(text: string, font: BigFont, limits: FontLimits): boolean {
  const size = bigSize(text, font);
  return (
    (limits.width === undefined || size.width <= limits.width) &&
    (limits.height === undefined || size.height <= limits.height)
  );
}

/**
 * The font to actually draw `text` in: the one asked for when it fits, and
 * otherwise the biggest font that does — never a font BIGGER than the one
 * asked for, so a fallback only ever shrinks a hero. When nothing fits (a pane
 * too narrow for even the smallest figlet) the smallest one is returned
 * anyway: a clipped hero still says the time, and a hero that vanished doesn't.
 *
 * "Biggest" is measured on this very text, in lines first and cells second —
 * height is what a figlet trades on, and `shade` at 8 lines reads as a nearer
 * relative of `huge` than `block` does even though `block` is wider.
 */
export function fitBigFont(text: string, font: BigFont, limits: FontLimits): BigFont {
  if (bigFits(text, font, limits)) return font;
  const asked = bigSize(text, font);
  const ranked = BIG_FONTS.map((f) => ({ font: f, size: bigSize(text, f) }))
    .filter((c) => c.size.height <= asked.height && c.size.width <= asked.width)
    .sort((a, b) => b.size.height - a.size.height || b.size.width - a.size.width);
  return ranked.find((c) => bigFits(text, c.font, limits))?.font ?? ranked[ranked.length - 1]?.font ?? font;
}

/**
 * Resolve whatever someone typed to a figlet's name: the name itself, or an
 * unambiguous substring ("hug" -> huge, "pal" -> pallet). Null when nothing
 * matches, and when more than one does — the same contract `resolvePreset` has
 * for palettes, so `theme.font {"font":"s"}` is refused rather than guessed
 * between `slick` and `shade`.
 */
export function resolveBigFont(input: string): BigFont | null {
  const q = input.trim().toLowerCase();
  if (!q) return null;
  if (isBigFont(q)) return q;
  const hits = BIG_FONTS.filter((f) => f.includes(q));
  return hits.length === 1 ? hits[0]! : null;
}
