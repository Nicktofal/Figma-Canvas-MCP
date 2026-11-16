# Changelog

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
