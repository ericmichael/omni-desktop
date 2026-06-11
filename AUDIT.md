# UI/UX Teardown — Omni Code Launcher

> Audit performed 2026-06-10 against a live instance (`npm run dev:server`, browser build) driven
> with Playwright at desktop (1440×900) and mobile (390×844) viewports, plus a code-level pass on
> the shell, navigation, onboarding, and message rendering. Screenshots referenced as
> `desktop-NN` / `mobile-NN` were captured at the repo root during the audit.
>
> Framing: a consultant's pass holding the app to the bar Apple Design Award judges apply —
> one obsessively-polished signature interaction, native-feeling mechanics, motion as
> communication, ruthless editorial omission, and inclusivity as table stakes.
>
> **Execution status (2026-06-11):** the full gameplan has been executed on
> `feat/merge-seed-data` — Phase 0 polish (9840b1b), Batch 1 language + shaping removal
> (ce2eb93), Batch 2 column identity/status (921f216), Batch 3 mobile structure (746b3de),
> chat unification (06f3ae7, plan at docs/chat-unification-plan.md), Phase 2 motion system
> (19a246e), Phase 3 teaching empty states + onboarding (294af50), Phase 4 ⌘K palette /
> keyboard map / live regions (7e8c64d). Dock-icon live indicators were cut by decision;
> chat-in-deck is deferred (one-line filter change when wanted).

## The one-paragraph verdict

The bones are genuinely good — consistent Fluent token usage, a coherent dark theme, real iOS
safe-area engineering, arrow-key nav in the rail, sessions that survive reconnects. And there is a
real, award-class idea in here: **the Code Deck — parallel agent columns, each a mini-OS with its
own chat/code/desktop/browser/terminal**. Nothing else looks like that. But the product currently
presents as an engineer's debug console wearing a UI kit: raw tool calls and UUIDs in the primary
surface, the same content rendered twice in several places (ticket status, page titles), three
competing names for the same concept, and desktop layouts that use 55% of the screen. The gap to "award-grade" is not
visual styling — it's that almost no *editorial* decisions have been made about what the user
should see, in what language, and what the app's one signature moment is.

---

## Part 1: Structural problems (the expensive ones)

### 1.1 Three front doors to the same room

A Chat conversation, a Spaces column, and a ticket's Autopilot run are all the same primitive — an
agent session — presented in three unrelated UIs with three navigation models (drawer list, deck
columns, kanban → detail → "Chat" button). The nav offers Chat / Spaces / Projects with no
expressed relationship: Spaces columns are titled by project name ("Omni Ecosystem" twice,
indistinguishable), Projects contain tickets that secretly spawn sessions, and Chat is just one
more session. A new user cannot form a mental model of where work lives. This is the root cause of
half the smaller issues below.

### 1.2 The app speaks engineer, not user

Observed in one pass: "Supervisor — Phase: idle", "Shaped", "WIP slots used",
"Host (no isolation)", "Run In: Host", "Devbox (dev)", "Code Deck background" (in Settings, for a
tab called Spaces), "Agent Session" vs "session" vs "conversation" vs "column". Internal
FleetManager/TicketMachine vocabulary leaks straight into UI copy. Award-winning apps have exactly
one name per concept, and it's the user's name, not the implementation's.

### 1.3 The chat transcript is a debug log

- ~~Voice replies appear twice (speak tool row + bubble)~~ — withdrawn on review. The `speak` row
  is an action record: it tells the user audio was actually played, and the agent separately
  writing the same text is its own choice for the reader's convenience. Both carry information;
  hiding either loses signal. The remaining (cosmetic) refinement opportunity is presentation —
  the row repeats the full message text as raw `(message: "…")` args where a compact "Spoke
  aloud" row would do — not removal.
- ~~Duplicate user message in a deck column~~ — initially flagged as a bug (two adjacent user
  bubbles with near-identical text), but it turned out the user had manually re-sent a copy-pasted
  version of the message after an app restart. Not a defect. The residual UX observation: after a
  restart there was apparently no signal that the original message had been delivered, which is
  what prompted the re-send — worth a "sending/delivered/queued" state on the last user message
  when a session reconnects.
- `task_create (subject: "Investigate browser/server built-in browser link flakiness", descri...)`
  — truncated raw arguments presented as primary content.
- The composer's workspace chip shows a raw UUID (`9e3cae13-8af3-4b2d-8f82-b7c6…`): the chip shows
  `basename(workspacePath)` (`src/renderer/omniagents-ui/components/Input.tsx:270`) and the
  workspace dir is a UUID.
- The Conversations drawer is full of `You are working toward a specific …` ×12 — titles are
  derived from the first user message (`src/renderer/omniagents-ui/lib/utils.ts:43`), so
  orchestrated sessions are titled by their injected prompt — alongside "1011 messages" /
  "944 messages" counts that signal noise, not value.

Each of these individually is small; together they tell the user "this surface is for the
developers of the app, not for you."

### 1.4 Desktop doesn't use the desktop

Settings, ticket detail, board, and project pages are a left-anchored column with the entire right
half of a 1440px window empty (desktop-01, -06, -07). The deck in Tile mode with two columns also
strands a third of the screen. Either center content with a max-width, or earn the width (detail
panes, activity). Right now it reads as an unfinished responsive layout — the single most
"generic MVP" tell in the whole app.

### 1.5 First-run is a config form, not a product

Onboarding is provider-type → API key → model ID → validate → CLI install
(`src/renderer/features/Onboarding/OnboardingWizard.tsx`). The first thing the product asks of a
new user is to know what "OpenAI-compatible" means and to paste a model ID string. There is no
moment where the product demonstrates its value before demanding configuration. ADA-grade apps
invert this: show the magic with zero config (local/demo model, or a guided first session), defer
setup until the user wants more.

---

## Part 2: Catalog of concrete defects

### Trust-killers (visible bugs)

1. Ticket status shown twice, adjacent: a "Completed" dropdown next to a "Completed" chip
   (desktop-07).
2. Project page renders its H1 twice — page header "GA Release Brief" immediately above the
   document's own identical H1 (desktop-05; worse on mobile-07).
3. Ticket descriptions render literal backticks — markdown unprocessed in the Overview tab.
4. Mobile composer at 390px: the mic icon overlaps the "Devbox (dev)" chip (mobile-03).
5. Tooltips stick open after tap/click and sit over content — "Chat", "Spaces", "Projects",
   "Toggle sidebar" all captured frozen mid-screen at a touch-sized viewport. Tooltips shouldn't
   exist on touch.
6. `<button>` nested in `<button>` in `src/renderer/features/Tickets/WorkItemsList.tsx:218`
   (console validateDOMNesting error) — invalid markup and an accessibility hazard.
7. 11× "WebSocket replaced" console errors during a single short session
   (`src/renderer/omniagents-ui/rpc/client.ts:114`).
8. "New" → "Agent Session" eagerly creates a session named "New Session" in the list *before*
    any project is chosen; abandoning the picker leaves orphans.
9. The window title flips between "Omni Code" and "Omni" depending on tab.
10. The ASCII-art logo is literal block glyphs in the DOM — a screen reader announces
    `█▀█ █▀▄▀█ █▄ █…`. Needs `role="img"` + `aria-label="Omni"`.

### Confusion and redundancy

11. Two deck columns both titled "Omni Ecosystem" with no disambiguator (branch, task,
    started-when). Focus mode shows the same two identical labels in its session list.
12. Board rows: a "Completed" chip on **every** row of a 20-row list (zero information), some rows
    carrying two or three chips in inconsistent order ("Review" + "Completed";
    "Completed" + "Software Column Work…"). Plus an unexplained colored dot per row.
13. Projects Home (desktop): a giant "0 / 3 WIP slots used" with three gray progress bars as the
    hero of an otherwise empty screen, and "Nothing pinned. Pin a project or milestone in the
    sidebar to focus on it here" — instructing the user to find a pin affordance that only exists
    on hover (and sits so close to the row target it gets clicked by accident; this audit
    accidentally pinned a milestone that way).
14. Ticket header strip: "No milestone · Unassigned · Chat · ▶ Autopilot" — two of these are
    buttons, two are metadata, all styled alike.
15. The "More" page on mobile contains exactly one item (Settings) plus a version string — an
    entire tab slot spent on a page with one row.
16. Inbox tabs "Inbox 1 / Later 7 / Archive 0" with a lone item tagged "Shaped" — Shape-Up jargon
    presented as a status.

### Mobile-specific

17. In Spaces on mobile, the bottom tab bar is *replaced* by the column dock; the only exit is an
    unlabeled top-left back arrow. The New Session screen has neither dock nor tab bar — a
    dead-end with one secret door. (And the back arrow exits to Chat, not to where you came from.)
18. Tile mode at 390px shows ~1.1 columns — a desktop multitasking layout offered on a screen
    where it can't mean anything. The Tile/Focus toggle shouldn't exist on phones; the deck should
    be a swipeable pager with a column switcher.
19. Drawers (Conversations, Projects tree) have no scrim, don't dim content, and persist across
    tab switches — after a resize, the Chat drawer sat on top of the Spaces tab (mobile-01).
20. Settings on mobile is 13 desktop tabs in a horizontally scrolling strip with a visible
    scrollbar (mobile-08) — the canonical "desktop UI squeezed into a phone" pattern; should be a
    grouped list with drill-in pages.
21. The Projects IA on mobile requires hamburger → tree drawer → expand project → tap sub-node,
    with the drawer closing between hops. A desktop tree control doing a phone navigation stack's
    job.

---

## Part 3: What separates this from an award winner — applied here

Winners have (a) one obsessively-polished signature interaction, (b) native-feeling mechanics with
bespoke visuals on top, (c) motion/haptics as communication, (d) ruthless editorial omission,
(e) inclusivity as table stakes.

**You already own (a) — you just haven't committed to it.** The deck *is* the product. "Deck mode
= the user chose multitasking; each column is a mini-OS" is a genuinely original interaction model
(nobody is doing TweetDeck-for-agents with per-column desktops). But today the deck is one of five
tabs, its name disagrees with itself, its columns are anonymous, and its most magical property —
glanceable parallel agent activity — is conveyed by gray "Completed" chips instead of life.

What an award-class deck looks like: columns with identity (project + branch + a live one-line
"now doing X"); dock icons that are *live indicators* (terminal icon pulses when a command runs,
browser icon shows a favicon, code icon shows a diff count); a column "breathing" while its agent
works and settling when it finishes; new columns sliding in with one consistent spring;
drag-to-reorder with physics; Focus mode as a zoom *into* a column (shared-element transition),
not a different screen. `VoiceGlow` and `GlobalAgentAmbientGlow` already exist — the
ambient-status visual language is started; it should become the system, not a garnish.

**The transcript needs an editorial layer (c + d).** Collapse tool calls into human activity
lines — "Pushed branch · Created PR #13 ✓" — one line per action, expandable for the raw call,
hidden entirely for `speak` (it duplicates the bubble). The copy/like/dislike strip should appear
on hover/long-press, not permanently under every two-line joke. The deck column then becomes
readable at a glance, which is the whole premise of a deck.

**Mechanics must be platform-native (b).** Mobile: drawers with scrims and swipe-to-dismiss, no
tooltips, no horizontal tab strips, bottom nav never disappears without a replacement, system back
behaves. Desktop: a real keyboard model (⌘1–9 jump columns, ⌘N new session, ⌘K command palette —
hotkey infra already exists), and content that uses the window.

---

## Part 4: Gameplan

**A note on honesty first:** an Electron/PWA app cannot literally win an Apple Design Award —
winners are native App Store apps, and judging explicitly rewards deep platform adoption. The plan
below gets the app to the *bar* ADA judges apply; if the award itself ever becomes a goal, the end
state is a native SwiftUI shell around server mode (the architecture — renderer talking to
managers over WS — is well-positioned for that). Meanwhile, the same qualities win users.

### Phase 0 — Credibility sweep (1–2 weeks)

Fix everything in the defect catalog: dedupe messages/status/titles, render markdown in tickets,
replace UUID chips with project names, fix the mic overlap, kill touch tooltips, fix
button-in-button, name new sessions lazily, label the logo, silence the WebSocket error spam. None
of this needs design; all of it is the difference between "MVP" and "cared-for."
**Acceptance test:** a 10-minute session producing zero console errors and zero visibly duplicated
content.

### Phase 1 — One language, one primitive (2–4 weeks)

Decide canonical names (recommendation: the tab is **Spaces**; a space *contains* sessions;
"Code Deck" disappears from user-facing copy; "Autopilot" opens a session like any other). Make
Chat a special case of the same column/session UI rather than a parallel implementation — that
single move deletes the duplicated-transcript class of bugs *by construction*. Rewrite all jargon
copy ("Host (no isolation)" → "Run directly on this computer"; "Supervisor Phase: idle" → nothing,
or "Waiting"). Session titles become generated summaries, never prompt text. Restructure mobile
nav: tabs persist everywhere; deck = swipeable pager; Settings = grouped list with drill-ins;
Projects = a real navigation stack instead of a tree-in-a-drawer.

### Phase 2 — The signature (4–8 weeks)

All polish budget goes to one thing: the deck as a living surface. Column identity headers; live
dock indicators; one motion system (a single spring curve for column enter/exit, Focus as a zoom
transition, interruptible); ambient activity glow unified with the existing voice glow;
drag-reorder. Write a motion spec (durations, springs, what may animate) so it stays coherent.
Everything else in the app stays deliberately quiet — restraint is what makes the one signature
read.

### Phase 3 — First-run and empty states (2–3 weeks, parallelizable)

Onboarding becomes outcome-first: launch into a working space immediately (bundled/local default
or guided key entry with inline validation), and the first empty column teaches by offering three
one-tap example tasks rather than a blank "How can I help you today?". Projects Home's empty state
offers the action ("Pin one ↓" with the pin visible), not a description of a hidden affordance.

### Phase 4 — Inclusivity and depth (ongoing)

VoiceOver/screen-reader pass (labels for dock icons, live-region for agent status), full keyboard
map + command palette, reduced-motion variants for every Phase-2 animation, text-scaling audit,
then platform depth where the app lives: PWA install/standalone polish (the safe-area work is
done — finish the story), macOS menu-bar presence and actionable notifications in Electron.

### Strategic summary

Stop spreading effort evenly across five tabs. Spend it 70% on the deck, 20% on language/IA, 10%
on everything else — because "parallel agents you can *see* working" is the one interaction nobody
else has, and it's the kind of thing design awards are actually given for.
