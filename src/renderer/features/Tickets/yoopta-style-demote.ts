/**
 * Demote @yoopta-injected stylesheets below Tailwind's utilities.
 *
 * The @yoopta/themes-shadcn and @yoopta/ui packages style-inject global
 * `<style>` tags at import time. Those sheets ship their own copies of
 * utility classes (`.bg-background`, `.bg-popover`, …) in the shadcn-v3
 * convention — `background-color: hsl(var(--background))` — which is invalid
 * against this app's v4 full-color tokens (`hsl(#09090b)` parses, then dies
 * at computed-value time), and because the sheets are UNLAYERED they beat
 * Tailwind's layered utilities. Net effect: every dialog/popover in the app
 * painted transparent once the Pages editor chunk loaded.
 *
 * Tailwind already generates valid v4 versions of every class the editor
 * markup uses (the `@source` scans in tailwind.css cover both packages), so
 * the colliding rules are pure harm. Wrapping each injected sheet in
 * `@layer yoopta` — pre-declared in tailwind.css between `base` and
 * `components` — makes collisions resolve to Tailwind's valid rules while
 * yoopta's non-colliding component chrome keeps working (and still beats
 * preflight).
 *
 * Matching is by content signature, not by package: fourteen dist files
 * across the two packages inject, and any future one with the same broken
 * convention gets caught automatically.
 */

const LEGACY_TOKEN_SIGNATURE = 'hsl(var(--';
const LAYER_PREFIX = '@layer yoopta{';

/** Wrap every legacy-convention injected sheet; returns how many were demoted. */
export function demoteLegacyYooptaStyles(doc: Document = document): number {
  let demoted = 0;
  for (const style of Array.from(doc.querySelectorAll('style'))) {
    const css = style.textContent ?? '';
    if (!css.includes(LEGACY_TOKEN_SIGNATURE) || css.startsWith(LAYER_PREFIX)) {
      continue;
    }
    style.textContent = `${LAYER_PREFIX}${css}}`;
    demoted++;
  }
  return demoted;
}
