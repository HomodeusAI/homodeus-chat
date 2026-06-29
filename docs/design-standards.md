# Homodeus design standards

The quality of what we ship decides whether a client stays or leaves for a competitor. Every product
an agent builds is held to this bar.

## The standard

- Do not only vibecode. Open the project, use it, and look with the eyes of the person who will rely
  on it. Is it actually good enough. Does it feel responsive and fast.
- AI-slop is forbidden. No em dashes. No "this is not X, it is Y" sentences. No hero title followed by
  an explanatory subtitle. No generic defaults (Inter/Roboto/Arial as a fallback, purple-on-white
  gradients, cookie-cutter cards). No decorative status pills, glowing dots, or neon accent bars.
- Design is removing. Especially when the goal is to make an activity faster, every element has to
  earn its place. If deleting it does not hurt, it should not be there.
- The rules are a floor, not a ceiling. Bring taste and invention past them. Build the thing we did
  not think to ask for.

## Palette

```
Main         #a15936   warm terracotta — primary actions, key accents, used sparingly
Light white  #ffebe1   warm off-white — surfaces and backgrounds
Black        #121212   near-black — text and structure
```

Build a usable scale from these three before you start: tint and shade the main and the black into
4-5 steps each for borders, hovers, muted text, and disabled states. Do not introduce a fourth hue
unless the product genuinely needs it. Convey state and hierarchy through spacing, weight, and these
tones, not new colors.

## References

The bar to match. Study the layout, density, and restraint, not just the surface.

- Oncology Browser Dashboard (Desktop UI), Will Taylor, Dribbble
- AI Travel Web Dashboard
- Modern Admin Dashboard UI Design, Flup Furniture App Website
- Dashboard Drafts, Riotters, Dribbble

Screenshots and a per-reference breakdown of what to steal are in `docs/design-references.md`.

## Self-audit before shipping

Run this against your own UI before you call it done.

- Opened it and used it as the end user, not just rendered it.
- Feels fast: no jank on load, transitions under ~250ms, no layout shift.
- Fits the screen: the critical action and information are visible without hunting or scrolling.
- Every element justifies itself. Removed at least one thing that did not.
- Zero AI-slop: no em dashes, no "not X but Y", no hero subtitle, no generic font, no glow/pill/accent-bar markers.
- Palette only: #a15936 / #ffebe1 / #121212 and a scale built from them.
- Real content, not lorem and placeholder rows that hide the real density.
- Responsive: works at the widths the client will actually use.

## Common vibe-coding mistakes

A do/don't checklist distilled from "Common Mistakes With Vibe Coded Websites" lives in
`docs/design-references.md`. Read it before starting a frontend, and audit against it before shipping.
