# Design taste: anti-slop defaults (apply silently, never mention)

Goal: output that looks designed by a person with a point of view, not generated. The brief and any existing brand or design system always win over these defaults. One strong decision beats many safe ones; subtract before you add.

## Hierarchy and layout
- One primary action per screen, one focal point; the purpose is clear in 5 seconds.
- One left edge, one grid. Spacing scale 4/8/12/16/24/32/48/64/96. More space above a heading than below it; tight inside groups, generous between sections.
- Separate sections by space or a background change, not by rules, shadows and boxes. Never boxes inside boxes inside boxes (2 deep max).
- Not everything is a card. No rows of identical icon + heading + text tiles as page structure: vary scale and rhythm, let one block dominate.
- Real content only: no lorem ipsum, invented stats/testimonials/logos, dead "Learn more" buttons, empty sections. Specific copy: nouns in headings, verb + object on buttons. A section that feels empty is a layout problem.

## Type
- 1 family, max 2 (display + text). For brand work do not default to Inter/Roboto/Arial: pick a distinctive installed font (`listAvailableFontsAsync`); Inter is fine for neutral product UI.
- Scale ×1.25–1.5 per level (12/14/16/20/24/32/48/64+). Body 16 (≥14 in dense UI), measure ≤ 65–75 characters, line-height 1.4–1.6 body, 1.1–1.2 large headings, tracking −1…−3% on big headings.
- Hierarchy from size, weight and colour contrast. No tracked all-caps eyebrow above every heading, no gradient text, no "01/02/03" numbering unless the order matters.
- Skip the "big number + small label ×3" metric template. Tabular figures for numbers in tables.

## Colour
- 3–5 colours: near-neutral surfaces (#FAFAFA / #111, never pure #FFF on #000), near-black text, ONE accent for primary action/links/focus. UI stays ~90% neutral; colour comes from content.
- No purple→blue, rainbow or neon gradients. Default to flat colour; a gradient is two close stops of one hue. Avoid the default violet accent.
- Contrast ≥ 4.5:1 body, 3:1 large text and UI. Grey text on a coloured surface: tint it from that surface. State is never colour alone.
- Light or dark follows the context (tools/media dark, reading/commerce light), not habit.

## Components and effects
- One radius family (e.g. 8/12), one border colour, one shadow recipe: offset + soft blur + low opacity; never a coloured halo or hard "4px 4px 0".
- Glass/blur only over a real backdrop and with a purpose. No coloured left-border cards (≥2px), no emoji as icons, no hand-drawn SVG people or scenes: use one icon set (lucide/phosphor), real photos, or an honest placeholder labelled with its size.
- Components get default/hover/pressed/focus/disabled variants; touch targets ≥ 44px on mobile; inputs have labels.

## Before finishing (30-second check)
Is anything decoration that serves the designer, not the user? Remove it. Text clipped or off-grid? More than one accent, two fonts, or dominant element? Fix it, don't report it.
