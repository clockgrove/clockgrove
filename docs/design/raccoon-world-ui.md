# Raccoon World UI composition

Authority: the [visual and interaction contract](../waves/clockgrove-wave-4-visual-projection-web-client-implementation-plan.md#4-visual-and-interaction-contract) (wave plan section 4). This note records how `apps/web` composes it; if they differ, the wave plan wins. Styles are in `apps/web/src/raccoon-world.css`, markup in `apps/web/src/yard.tsx`.

## Reference

The owner-supplied mockup, [reference/raccoon-world-reference.png](reference/raccoon-world-reference.png) (1672×941), is the visual target for composition and art style. It is a reference only: wave plan [section 4.5](../waves/clockgrove-wave-4-visual-projection-web-client-implementation-plan.md#45-never-fake-the-world) forbids using it, or any static image, as a runtime background with hotspots.

What it shows, for agents that cannot view images:

- Camera and style: a high three-quarter isometric view of a garden at dusk. Painterly, rendered storybook realism, not pixel art: soft fur edges, wet reflective ground, warm window and lantern light against cool rain.
- Scene, filling the area left of the rail: a house with a porch at the left, a "Raccoon Den" sign under the porch with kits peeking out; a large tree trunk at the center; a bird feeder hanging from a post; raised garden beds at the right; a stepping-stone path through puddles; a mailbox, a lantern post and a tipped trash can that a raccoon is investigating. No text dump is visible in canvas mode.
- HUD: the spaced-caps wordmark "RACCOON WORLD" at the left, followed by six round navigation icons (deferred to Wave 8 RW-0807); "Day 12 · 4:37 PM" and a rain-cloud weather glyph centered; camera, shield and menu buttons at the right.
- Selection: a glowing green ring on the ground around the selected raccoon, and a dark pill label with its name ("Stevie") above it.
- Event feed: a floating dark card at the lower left. Each row is a round semantic icon (rain drop, leaf, raccoon face, heart), a plain sentence such as "It started raining." and the world time.
- Right rail: the name "Stevie" and a close button; a large circular portrait with a leaf badge; a green status line ("Investigating the trash can"); a 2×2 grid of actions Talk, Observe, Remember and Why?; chat bubbles with times; and a "Message Stevie…" input with a send button.

Stevie's identity reference is [reference/stevie-sprite-sheet.png](reference/stevie-sprite-sheet.png) (1536×1840): an owner-generated contact sheet of 57 numbered frames of Stevie in 8 columns of 192 px cells on a pale background. It fixes Stevie's look: the same painterly style as the mockup, with a consistent mask, ringed tail and fur in every frame. The rough pose groups are standing or idle facing right (frames 0–5, 22–25, 45–56), walk right (6–13), walk left (14–21), crouch and hop (26–31), head turn and look down (32–38), and sit and groom (39–44). It is a raw sheet, not a game asset: the baked background, the frame numbers and the per-cell alignment still need processing before any frame is used at runtime.

## Tokens

Tokens are CSS variables on `[data-tokens="raccoon-world-ui@1"]`, the shell root. The version is `raccoon-world-ui@1` and every variable carries the `--rw-v1-` prefix. A breaking change to a value's meaning adds a new prefix and token version instead of editing these.

| Token | Role |
| --- | --- |
| `--rw-v1-bg` | Near-black charcoal page background with a warm olive undertone |
| `--rw-v1-panel` | Translucent charcoal/olive panel (HUD, rail, feed) |
| `--rw-v1-panel-solid` | Opaque panel equivalent |
| `--rw-v1-control` | Button, select and input background |
| `--rw-v1-border` | Aged-brass/khaki hairline border |
| `--rw-v1-text` | Primary text |
| `--rw-v1-text-muted` | Secondary text (event times, disabled controls) |
| `--rw-v1-accent` | Sage primary accent: selection, live, focus outline |
| `--rw-v1-rain` | Rain blue (weather) |
| `--rw-v1-event` | Event amber |
| `--rw-v1-affection` | Affection coral (wellbeing) |
| `--rw-v1-warning` | Warning rust |
| `--rw-v1-error` | Error red |
| `--rw-v1-font` | Humanist sans stack |
| `--rw-v1-radius` | Modest corner radius |
| `--rw-v1-space-1`, `-2`, `-3` | 4, 8 and 16 px spacing steps |
| `--rw-v1-hud-height` | HUD height, 60px |
| `--rw-v1-rail-width` | Rail share of the desktop width, 20% |
| `--rw-v1-feed-width` | Desktop feed width and scene-column gutter, min(320px, 24vw) |
| `--rw-v1-sheet-bar` | Narrow-layout sheet bar, 56px: the collapsed rail's minimum height and the feed sheet's bottom offset |

The HUD height, the breakpoint and the 4:1 column split come from wave plan section 4. The other sizes are decisions of this note, not of the wave plan:

- `--rw-v1-sheet-bar`, 56px: a 48px touch target (WCAG 2.5.8 recommends at least 24px; 48px is the Material touch-target size) plus the 8px sheet padding. The collapsed rail has this as its minimum height, so the feed sheet at `bottom: 56px` sits exactly on the rail's top edge; the narrow Chromium step checks that the feed clears the rail.
- `--rw-v1-feed-width`, `min(320px, 24vw)`: 320px is the narrowest common phone width, so a feed item wraps the same as on a phone; 24vw keeps the scene column at 1280px wide enough for the 640px canvas (1024px column less the gutter and padding leaves 669px).
- Sheet heights 40vh (feed) and 60vh (open rail): an open sheet leaves at least 40% of the viewport for the scene.
- World selector `max-width: 180px`: keeps the HUD's start column on one line at 1280px with the wordmark beside it.

Text and background pairs meet WCAG AA (4.5:1); axe checks them in the browser. Interactive controls show a 3px sage focus outline.

## Desktop composition (1200px and wider)

`.rw-shell` is a grid of at least the viewport's height: rows `60px 1fr`, columns `4fr 1fr`. The window scrolls the scene; the HUD and the rail are sticky. No inner container scrolls the canvas, because Phaser maps pointer positions from the window's scroll.

- HUD (`.rw-hud`, row 1, one line): content-sized minimum tracks keep the wordmark and selector together without wrapping; small-caps spaced wordmark and World selector at the left, the world clock (`.rw-clock`: day and time, Running or Paused, speed, weather) centered.
- Scene (`.rw-main`, about 4/5): the canvas and the complete text scene.
- Entity rail (`.rw-rail`, about 1/5, right): the rail collapses to its toggle but keeps its column; selection is unaffected.
- Material event feed (`.rw-feed-dock`): fixed at the lower left of the scene, in a left gutter of the scene column (`--rw-v1-feed-width`), so it never covers the canvas or a control; it scrolls past 40vh.

The clock and feed read the authorized world-status read; feed items that concern an entity select it and open the rail. An item whose entity is not in the viewed scene (it left, or the audience filter hides it) is inert and says "(not in view)". The read is issued for the scene's committed revision at most once a second (`STATUS_INTERVAL_MS` in `apps/web/src/yard.tsx`); while the clock's revision is behind the scene's, the clock says "updating".

Each layout remembers whether its rail and feed are open: the desktop layout starts with both open, the narrow one with both closed, and crossing the breakpoint restores the destination layout's last choice instead of forcing it.

## Breakpoint and narrow layout

The breakpoint is 1200px. It sits below the 1280x720 laptop width that acceptance names and above tablet portrait. It is stated in `DESKTOP_MEDIA` in `apps/web/src/yard-state.ts` and in the two media queries of the CSS; change them together.

Below it the shell is a block layout. The HUD sticks to the top and may wrap, keeping clock and weather visible. The rail becomes a bottom sheet, closed by default, and the feed becomes a collapsed sheet just above it. Sheets use the opaque panel token so underlying scene text cannot show through. Recorded Why opens as an opaque, scrollable panel above the sheets on narrow layouts. Each sheet is opened by its own button (**Open entity rail**, **Open event feed**); opening or closing never changes the selection. The scene gets bottom padding so it scrolls past both sheets.

The Phaser canvas is never CSS-scaled, because pointer picking depends on its pixel size. When the viewport is narrower than the canvas the window scrolls horizontally; no inner container scrolls it, because Phaser refreshes its canvas bounds only on window resize and maps pointers from the window's scroll. The narrow Chromium step picks on the canvas after a horizontal scroll.

## Color never carries state alone

Run state is the words Running or Paused plus a glyph; rain is the words Dry or Rain N% plus an umbrella glyph and a dotted underline for rain; feed categories show their category name plus a diamond glyph and a distinct underline style. Glyphs are decorative `::before` content.

## Out of scope

Card actions, and art and assets. The navigation icons and the capture, safety and menu utilities are deferred to Wave 8: see the [RW-0807 amendment](../waves/clockgrove-wave-8-living-neighborhood-demo-implementation-plan.md#rw-0807--complete-visualaudio-pack-and-reference-ui-polish).
