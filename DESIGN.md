---
version: alpha
name: Clockgrove world shell
description: Default UI tokens of the world-agnostic web shell. A world theme overrides them through the shell input seam.
colors:
  bg: "#14181e"
  panel: "rgb(32 38 48 / 92%)"
  panel-solid: "#202630"
  control: "#303947"
  border: "#7e8b9e"
  text: "#edf1f5"
  text-muted: "#b7c1cf"
  primary: "#9bbce0"
  rain: "#8ec1ea"
  event: "#e8b84e"
  affection: "#f4958a"
  warning: "#e39a62"
  error: "#ff8f86"
typography:
  body:
    fontFamily: "\"Segoe UI\", \"Helvetica Neue\", Helvetica, Arial, system-ui, sans-serif"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.4
rounded:
  md: 6px
  full: 9999px
spacing:
  space-1: 4px
  space-2: 8px
  space-3: 16px
  hud-height: 60px
  rail-width: 20%
  sheet-bar: 56px
  feed-width: "min(320px, 24vw)"
components:
  page:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
  hud:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    height: "{spacing.hud-height}"
    padding: "{spacing.space-3}"
  wordmark:
    textColor: "{colors.primary}"
    backgroundColor: "{colors.panel}"
  rail:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    width: "{spacing.rail-width}"
    padding: "{spacing.space-2}"
  event-feed:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    width: "{spacing.feed-width}"
    padding: "{spacing.space-2}"
  event-feed-time:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text-muted}"
  event-feed-icon:
    backgroundColor: "{colors.panel-solid}"
    textColor: "{colors.rain}"
    rounded: "{rounded.full}"
  selection-pill:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.full}"
  button:
    backgroundColor: "{colors.control}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "{spacing.space-2}"
  button-pressed:
    backgroundColor: "{colors.control}"
    textColor: "{colors.primary}"
  button-disabled:
    backgroundColor: "{colors.control}"
    textColor: "{colors.text-muted}"
  alert-event:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.event}"
  alert-affection:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.affection}"
  alert-warning:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.warning}"
  alert-error:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.error}"
---

## Overview

The shell is a quiet frame around a world. A dark, cool chrome keeps the scene the primary surface and the panels supporting it. The tokens here are the neutral defaults any world gets. A world restyles the shell by overriding tokens through the shell input seam ([world presentation](docs/protocols/world-presentation.md)); it never edits this file. A world's art direction lives in that world's own repository, not here.

## Colors

- **Bg (#14181e):** the page behind the scene.
- **Panel and Panel solid (#202630):** the surfaces of the HUD, rail and event feed. Panel is translucent at 92% so the scene is not hidden; Panel solid is for small marks that must stay opaque.
- **Control (#303947):** buttons, selects and inputs.
- **Border (#7e8b9e):** hairlines and control outlines. Components cannot carry a border color in the format, so no component entry references it.
- **Text and Text muted (#b7c1cf):** body text and secondary text such as timestamps and disabled controls.
- **Primary (#9bbce0):** the accent for selection, live state, focus rings and the wordmark.
- **Rain, Event, Affection, Warning, Error:** semantic accents for weather, notable events, affection, caution and failure. Color never carries state alone: each use pairs it with a glyph, a label or a border style.

## Typography

One humanist sans-serif stack at the browser's base size with a 1.4 line height. Weight 600 marks times and the wordmark; the wordmark alone uses small caps with wide letter spacing. Long identifiers wrap, so 320 CSS px at 200% text reflows without horizontal scrolling.

## Layout

A 4, 8 and 16 px spacing scale. On wide screens (1200 px and up, the desktop breakpoint of the scene state) the shell is a grid: a 60 px HUD row on top, then the scene beside a rail 20% wide and an event feed up to 320 px wide (at most 24vw). Narrower screens stack the regions and use a 56 px sheet bar. Layout sizes are tokens so a world can resize regions without new CSS.

## Elevation & Depth

Depth comes from tonal layers, not shadows. The page is the darkest layer, translucent panels sit above it, and solid panels and controls sit above those. Borders separate layers of the same tone. There are no drop shadows or gloss.

## Shapes

Modest radii: 6 px for controls, a full radius for portraits, feed icons and the selection pill. The portrait and icon shapes are circles.

## Components

- **HUD:** a wrapping flex row with the wordmark, world selector, navigation, clock and run state on a translucent panel with a bottom hairline.
- **Rail and event feed:** translucent panels with a hairline border and 8 px padding. Feed rows are a 28 px icon, a title and a right-aligned muted time; hover uses the control color.
- **Selection pill:** a fully round translucent pill with an accent hairline holding a name.
- **Buttons, selects, inputs:** control color, border hairline, 6 px radius. A pressed button takes the primary color and a 2 px primary border. A disabled button takes the muted text color.
- **Focus:** every focusable element shows a 3 px accent outline with a 2 px offset.
- **Alerts:** error text takes the error color with a 4 px left border.

## Do's and Don'ts

- Do read colors from the tokens; a world retheme must change the shell without touching component CSS.
- Do pair every semantic color with a glyph, label or border so color never carries state alone.
- Do keep body text at 4.5:1 contrast or better against its surface.
- Don't add shadows, gloss or pulsing motion.
- Don't name a world, its characters or its art in the shell's tokens or prose.
- Don't edit `apps/web/src/world-shell-tokens.css` by hand; run `node scripts/design-tokens.mjs --write`.
