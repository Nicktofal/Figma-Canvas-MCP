# Core: workflow + defaults (read first, applies to every task)

Never ask the user questions you can answer yourself: pick sensible defaults, build, state assumptions in one line at the end.

## Loop
1. `status`, then `read` target `file` once: reuse existing variables, styles, components, fonts, brand colours. Existing context beats these defaults.
2. Build: screens/sections → `render_html`; precise edits, components, variables, effects → `execute`; icons → `insert_asset` icon (`lucide:arrow-right`).
3. Look at the returned screenshot and fix what is wrong (clipped text, uneven spacing, contrast). If you cannot see images, use `read`, `to_code` or `compare` instead.
   When reproducing a reference image, loop: build → `compare` a against the reference (`images: "all"` shows a | b | diff) → fix the `hotspots` using their `hint` and colours → repeat until `verdict` is PASS. Use `preset: "strict"` for pixel-level work, `loose` for rough layouts.
4. One big call beats many small ones. Calls are atomic (an error rolls everything back) and each is one undo step; `history` undoes. Save `history {op:'version'}` before large changes.
5. Finish with: what you made (node ids) and warnings you could not fix. Do not claim success for things you did not check.

## Tool choice
`render_html` (HTML/Tailwind → Auto Layout/GRID) · `execute` (Plugin API; helpers `h`, data via `args`) · `motion` (native keyframes, exportable video) · `export` (files) · `to_code` (Figma → HTML/JSX) · `compare` (perceptual diff with PASS/FAIL verdict) · `prototype` (click/hover links) · `library` (team libraries) · `figma_rest` (comments, versions; needs FIGMA_TOKEN).
Effects in `execute`: `h.glow` (bloom), `h.iso` (isometric), `h.transform` (skew/affine); see skill `effects-glow-iso`.

## Plugin API pitfalls (execute)
- Colours are 0–1 floats; use `h.solid('#hex')`. Fills/strokes/effects arrays are immutable: assign new arrays.
- Load fonts before touching text (`h.font(family, style)`, `h.loadFonts(node)`); exact style names ("Semi Bold" vs "SemiBold") via `figma.listAvailableFontsAsync()`.
- `layoutSizing* = 'FILL'` only after the node is inside an auto-layout parent; `'HUG'` only on auto-layout frames and text. Setting `layoutMode` makes a frame hug: set sizing FIXED, then `resize`, for a fixed size.
- Always append to a parent, otherwise nodes land on the page root. Use `figma.getNodeByIdAsync`.
- Group multi-part objects (`figma.group`), name every layer (`Card / Title`, never `Rectangle 12`), delete test nodes you made.
- Masks: the mask layer must be the FIRST (bottom) child of its group.
- Limits: images ≤ 4096 px, video upload only in paid team files, no UI chrome (menus, publishing), one plugin at a time.

## Default taste (silent, always on)
Apply `design-taste` without being asked. For anything that moves apply `motion-principles`.
