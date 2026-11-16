# Changelog

## 0.3.0

- Several agent sessions can now share one Figma plugin connection. The first MCP process binds the port and becomes the hub; later processes attach to it as clients instead of failing with `EADDRINUSE`. Each agent has its own target file (`status` with `use`), and calls from different agents interleave on the plugin side. If the hub exits, a client takes over the port and the plugin reconnects by itself.
- `compare` is now perceptual: CIEDE2000 colour difference plus SSIM, an explicit PASS/FAIL verdict against tolerances (`preset` strict/normal/loose or `tolerance`, `maxMismatch`, `maxMeanDeltaE`, `minSsim`), a ΔE heat-map grid, worst cells with coordinates, average colours and a plain-language hint, `fit` (stretch/contain/cover), `region`, and `images: all` for an a | b | diff sheet. The `threshold` parameter is replaced by `tolerance`.
- New `execute` helpers: `h.glow` (Deep-Glow-style multi-radius additive bloom with radius, intensity, spread and tint), `h.iso` (isometric top/left/right projection) and `h.transform` (any affine warp around the centre). Documented in the new `effects-glow-iso` skill.
- `status` now reports `role` (`hub` or `client`).
- `h.transform` keeps the skewed edge length (Figma normalises skew axes, which shortened a skewed side by cos of the angle).

## 0.2.0

- Initial public release on npm: `render_html` (Auto Layout and native `GRID`), `execute` with rollback, `history`, motion and video capture, `compare`, `to_code`, `render_shader`, `prototype`, `library`.
