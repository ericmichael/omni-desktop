/**
 * Motion spec — the one spring language (UI/UX gameplan Phase 2).
 *
 * Rules:
 * - Everything structural moves with ONE of the two springs below. No
 *   per-component bezier inventions; if a surface needs a new feel, change it
 *   here, not locally.
 * - Only `transform` (position/scale) and `opacity` animate. Never width/
 *   height of text containers, never blur (except the static glass styles),
 *   never color transitions longer than 200ms.
 * - Entering elements: opacity 0 → 1 with a small upward/scale settle
 *   (`ENTER_INITIAL`). Departing elements just release; their neighbors
 *   spring into the freed space via layout animation (we animate the
 *   survivors, not the corpse).
 * - Shared-element morphs (Focus-as-zoom) use the gentle spring — large
 *   surfaces read as heavier.
 * - Reduced motion: framer-motion animations are globally disabled via
 *   <MotionConfig reducedMotion="user"> at the app root; hand-written CSS
 *   animations must each carry a `prefers-reduced-motion: reduce` override.
 */

/** Snappy settle for small/medium elements (columns, cards, list rows). */
export const SPRING_STANDARD = { type: 'spring', stiffness: 420, damping: 34, mass: 0.9 } as const;

/** Heavier settle for large surfaces (full-pane morphs, Focus zoom). */
export const SPRING_GENTLE = { type: 'spring', stiffness: 280, damping: 32, mass: 1 } as const;

/** Entering element pose — pairs with SPRING_STANDARD. */
export const ENTER_INITIAL = { opacity: 0, scale: 0.96, y: 12 } as const;
export const ENTER_ANIMATE = { opacity: 1, scale: 1, y: 0 } as const;

/** Plain fades (status rows, scrims) — short enough to never feel animated. */
export const FADE_DURATION_S = 0.18;

/**
 * dnd-kit sortable settle (CSS transition, not framer): an ease-out quint
 * that approximates SPRING_STANDARD's release without the overshoot — dnd
 * transforms snap to exact slots, so overshoot would look like jitter.
 */
export const SORTABLE_TRANSITION = {
  duration: 220,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
} as const;
