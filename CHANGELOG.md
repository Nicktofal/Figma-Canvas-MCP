# Changelog

## 0.4.0

- New plugin icon (the neon cursor, rebuilt as a vector with meshes, glow and grain); `assets/icon-128.png` is the file for Figma's publish form, and the plugin header shows it.
- `h.mesh`: chord-length tangents and monotone colour interpolation (no ringing beside sharp rims); node data is stored compactly and skipped above 100 kB (Figma's plugin-data limit).
- New `h.mesh` (with `h.meshGet`, `h.meshUpdate`): Illustrator-style gradient mesh. Nodes carry position, colour, alpha and optional bezier handles, joined by bicubic patches, so grid lines can be curved; `wrap` closes the grid into rings, discs and spheres; colours can be sampled from another layer (`from`). Rendered in the plugin UI (Oklab, crack-free tessellation) and applied as an image fill, so the layer keeps its outline. Skill `effects-mesh`.
- New `execute` helpers, documented in the new `effects-texture` skill: `h.grain` (film grain through the native NOISE effect, overlay layer for frames), `h.progressiveBlur` (native progressive layer/background blur along an axis) and `h.halftone` (dots, squares, diamonds or lines from the layer's pixels, as one vector or coloured dots). Pixel sampling goes through the plugin UI (canvas), so the plugin window must stay open.

## 0.3.1

- New `h.perspective(node, {shrink, amount} | {quad})`: true perspective with converging lines. Vector-like nodes become a warped vector (curves cut and re-fitted); frames, groups and images become an image-tile mesh. Documented in the `effects-glow-iso` skill.
- Fix: `h.glow` and the Glow tab put the glow far up-left when the layer's parent was not at 0,0 (clones were grouped by absolute position). Clones now take the layer's parent-relative transform, also inside auto-layout frames.

## 0.3.0

- Plugin **Glow tab**: select a glow group (or any layer to add one) and tune radius, intensity, spread, core, steps, blend and tint with live sliders; one drag is one Figma undo step. Glow settings are stored on the group, so glows made by agents appear there too. New `h.glowUpdate(group, patch)`.
- Stronger `h.glow`: intensity up to 8 (more copies per octave), new `core` parameter for the hot centre.
- Several agent sessions can now share one Figma plugin connection. The first MCP process binds the port and becomes the hub; later processes attach to it as clients instead of failing with `EADDRINUSE`. Each agent has its own target file (`status` with `use`), and calls from different agents interleave on the plugin side. If the hub exits, a client takes over the port and the plugin reconnects by itself.
- `compare` is now perceptual: CIEDE2000 colour difference plus SSIM, an explicit PASS/FAIL verdict against tolerances (`preset` strict/normal/loose or `tolerance`, `maxMismatch`, `maxMeanDeltaE`, `minSsim`), a ΔE heat-map grid, worst cells with coordinates, average colours and a plain-language hint, `fit` (stretch/contain/cover), `region`, and `images: all` for an a | b | diff sheet. The `threshold` parameter is replaced by `tolerance`.
- New `execute` helpers: `h.glow` (Deep-Glow-style multi-radius additive bloom with radius, intensity, spread and tint), `h.iso` (isometric top/left/right projection) and `h.transform` (any affine warp around the centre). Documented in the new `effects-glow-iso` skill.
- `status` now reports `role` (`hub` or `client`).
- `h.transform` keeps the skewed edge length (Figma normalises skew axes, which shortened a skewed side by cos of the angle).

## 0.2.0

- Initial public release on npm: `render_html` (Auto Layout and native `GRID`), `execute` with rollback, `history`, motion and video capture, `compare`, `to_code`, `render_shader`, `prototype`, `library`.
