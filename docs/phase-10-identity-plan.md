# Phase 10 — Identity & Depth: One-Knob Glass, Accent, Type, Scaling, SR Status Center

## Summary

Collapse the confusing two-knob theming system (theme picker + wallpaper-activated glass) into a
single knob: **material becomes a property of the theme**. Ship a new default theme — `omni`,
dark glass over a built-in quiet gradient backdrop, with an azure accent unified with the aura
language — plus a display typeface, a real text-size setting, a proper logo mark, a single
screen-reader status center, and the remaining reduced-motion overrides.

Decisions locked with Eric: glass by default via the one-knob model; accent = the glow
cyan/azure family (#5ac8fa); display face = Space Grotesk; text scaling = a Settings control.

## Key changes

### 1. Theme model: material follows the theme (`src/renderer/theme/fluent-themes.ts`)

- `ThemeDef` gains `material?: 'flat' | 'glass'` (default flat), `backdrop?: string` (CSS
  background value), and `builtinGlassTone?: 'dark' | 'light'`.
- New theme **`omni`**: `mode: 'dark'`, `material: 'glass'`, `builtinGlassTone: 'dark'`,
  base neutrals identical to the `default` theme's zinc family (these are the flat fallback and
  the opaque backstop), Inter body, JetBrains Mono. Brand ramp (azure, anchored on `#5ac8fa` at
  stop 100):
  `10:#04141c 20:#082636 30:#0b3a52 40:#0d4e6e 50:#0f628b 60:#1076a8 70:#118ac5 80:#2b9fd9
90:#45b4e9 100:#5ac8fa 110:#7dd3fb 120:#9eddfc 130:#bce7fd 140:#d6f0fe 150:#e9f7fe 160:#f4fbff`.
  xterm palette = `default`'s with `cursor/blue/brightBlue` moved to the azure family
  (`#5ac8fa` / `#45b4e9` / `#7dd3fb`).
- Built-in backdrop (static CSS gradients, no asset):
  `radial-gradient(1200px 800px at 80% -10%, rgba(90,200,250,0.16), transparent 60%),
 radial-gradient(1000px 700px at -10% 110%, rgba(94,92,230,0.12), transparent 55%),
 linear-gradient(160deg, #0b1016 0%, #0d1117 45%, #0a0c10 100%)`.
- Export `isGlassTheme(theme)` and `getThemeBackdrop(theme): string | null`.
- Other themes unchanged (utrgv branded header, vscode/teams flat). Auras/VoiceGlow keep their
  literal colors — the omni brand now matches them by construction.

### 2. Glass activation & consumers

- New derived state `$glassEnabled` (small module, e.g. `src/renderer/theme/use-glass.ts`):
  `isGlassTheme(store.theme) && !matchMedia('(prefers-reduced-transparency: reduce)').matches`.
  Subscribes to the store atom and the media query.
- Backdrop resolution in `MainContent`: user image (`store.codeDeckBackground`, a data URL,
  rendered as `backgroundImage: url(...)`) overrides the theme's built-in backdrop (rendered as
  `background: <gradient>`); glass tone = stored `glassTone` (luminance-derived at upload, as
  today) for user images, `builtinGlassTone` for the built-in backdrop.
- All 14 `isGlass = !!store.codeDeckBackground` call sites switch to `$glassEnabled` in lockstep
  (MainContent, Sidebar, Chat, CodeDeck, SettingsPage, PageView, Gallery, Tickets, ProjectPage,
  Dashboards, NotebookView, VoiceModal, SettingsModalOmniSandboxOptions, store init — no
  compat shims).
- Reduced transparency ⇒ fully flat: no glass vars, no backdrop, base neutrals (user image
  ignored while the preference is active).

### 3. Settings, schema, migration

- Schema `theme` enum: add `omni` **and the missing `teams-light`/`teams-dark`** (pre-existing
  landmine: `clearInvalidConfig: true` wipes stores persisted on Teams themes); default →
  `omni`. `OmniTheme` type gains `'omni'`. App fallback `?? 'teams-light'` → `?? 'omni'`.
- Add a theme-defs/schema parity unit test so an enum/defs mismatch can never recur.
- Display section (`SettingsModalOmniSandboxOptions`): Theme select lists Omni first;
  "Spaces background" renames to **"Background"**, renders only when `isGlassTheme(theme)`,
  options = built-in backdrop (default) or upload; "Reset" clears `codeDeckBackground`.
- Migration (pure function in `lib/store-init.ts`, applied in renderer init like
  `migrateLayoutMode`): if `codeDeckBackground` is set and the current theme is not glass →
  switch theme to `omni`, keep the image and `glassTone`. Appearance is preserved (glass vars
  override neutrals; only the brand tint changes). Users without a wallpaper keep their theme.

### 4. Display typeface

- Add `@fontsource-variable/space-grotesk`; import next to Inter in `App.tsx`.
- `applyCssVars` sets `--font-display: 'Space Grotesk Variable', 'Inter Variable', ui-sans-serif,
system-ui, sans-serif` for every theme.
- Apply (restrained, display sizes only): `ds/Heading`, onboarding card title, `CodeEmptyState`
  kicker + "Start a session" title, `ProjectsDashboard` gauge numerals. Nothing below 16px.

### 5. Text size setting

- Store key `textScale: number` (90 | 100 | 110 | 125, schema default 100; classify defaults to
  user/global — no settings-layers entry needed).
- `fluent-themes.ts`: replace the build-once lookup with cached `getFluentTheme(name, scale)` /
  `getThemeCssVars(name)` — scaling multiplies the numeric px of `fontSizeBase*`, `fontSizeHero*`,
  `lineHeightBase*`, `lineHeightHero*` tokens (round to int). `App.tsx` builds the theme from
  `(themeName, textScale)` and sets `document.documentElement.style.fontSize = scale + '%'` so
  Tailwind/rem surfaces (omniagents-ui) follow.
- Convert the ~16 hardcoded 9–12px **text** styles in renderer chrome (nav labels, dock labels,
  status/sub labels, focus list) to rem; icon geometry and paddings stay px.
- Settings Display gains "Text size" select: Small 90% / Default 100% / Large 110% /
  Extra large 125%.

### 6. Logo

- New `OmniMark` SVG component (ring + center dot, stroked with an azure→indigo gradient —
  echoes the orb/aura language), sized for the rail (~28px) with `role="img"`/`aria-label="Omni"`.
- `OmniLogo` keeps its API: utrgv branch unchanged; the ASCII branch is replaced by `OmniMark`.
- ASCII art demoted to an easter egg: one-time `console.log` of the block-glyph wordmark on
  renderer boot.

### 7. Screen-reader status center

- New `status-announcer`: a single visually-hidden polite live region at the App root, fed by
  `$columnActivity` transitions (announce **approval-waiting** and **finished** only, matching
  the notification triggers; label via the resolver shared with `agent-attention` — export
  `columnLabelFor(scope)` from there). Announcements within 1s coalesce ("Omni Ecosystem:
  finished · Launcher: waiting for approval"); the region clears after ~5s so repeats re-announce.
- Remove `role="status"` from `ColumnStatusLine` (visuals unchanged) — N working columns no
  longer produce N interleaved SR streams.

### 8. Reduced-motion remainders

- Sweep renderer chrome for `animationName`/long transitions lacking a
  `prefers-reduced-motion` override; known fixes: `ds/Skeleton` shimmer, omniagents-ui `Orb.css`,
  toast enter/exit. Spinners stay (conventional exemption).

## Interface changes

- `ThemeDef` += `material?`, `backdrop?`, `builtinGlassTone?`; exports
  `isGlassTheme(t: OmniTheme): boolean`, `getThemeBackdrop(t: OmniTheme): string | null`,
  `getFluentTheme(t: OmniTheme, scale: number): Theme`.
- `$glassEnabled: ReadableAtom<boolean>` replaces every `!!codeDeckBackground` material check.
- `StoreData` += `textScale: number`; `OmniTheme` += `'omni'`; theme schema enum += `omni`,
  `teams-light`, `teams-dark`; theme schema default `tokyo-night` → `omni`.
- `lib/store-init.ts` += `migrateThemeForGlass(theme: string, hasBackground: boolean):
OmniTheme | null`.
- `agent-attention` exports `columnLabelFor(scope: string): string`.

## Test plan

- `fluent-themes`: themeDefs keys ⇄ schema enum ⇄ OmniTheme parity; `isGlassTheme`; font-token
  scaling math at 90/100/125 (px values multiply and round; non-font tokens untouched).
- `store-init`: `migrateThemeForGlass` — wallpaper + flat theme → `omni`; wallpaper + `omni` →
  null; no wallpaper → null.
- `status-announcer`: pure transition→announcement builder (approval gained, finished, coalescing
  window, no announcement for working-start).
- Existing suites must stay green; eslint/prettier/tsc parity with baseline; dpdm no new cycles.
- Manual pass (needs the live app): glass legibility over both backdrops, reduced-transparency
  flat fallback, text-size at 125% on mobile width, VoiceOver/NVDA announcement of the status
  center.

## Assumptions

- One glass theme for now (dark). A light glass theme is deferred until someone wants it.
- Auras/VoiceGlow keep their literal spectrum colors; only the omni brand ramp aligns with them.
- Existing users without a wallpaper keep their current theme; only new installs and wallpaper
  users land on `omni`.
- `textScale` applies globally (no per-surface scaling); xterm terminal font size is out of scope.
- The `glassTone` store key and luminance detection remain unchanged for user wallpapers.
