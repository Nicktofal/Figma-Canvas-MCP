# Effects: glow, isometric and affine transforms

Helpers on `h` inside `execute`. They produce live, editable layers (no rasterising).

## `h.glow(node, opts)`: Deep-Glow-style bloom
Stacks blurred copies of the node above it, with blur radii doubling from a tight core up to `radius`, blended additively. Returns the group that holds the layers (named "Glow").

| option | default | meaning |
|---|---|---|
| `radius` | 48 | widest blur, px. Bigger = softer, wider haze |
| `intensity` | 1 | strength. 0.5 subtle, 1 normal, 2–3 hot neon |
| `spread` | 0.5 | 0 = tight bright core, 1 = wide soft haze, 0.5 = even across scales |
| `steps` | 5 | number of octaves (3–8). More = smoother falloff, more layers |
| `color` | source | tint override (hex) for every copy; use a saturated colour so the halo does not wash out to white |
| `blend` | `LINEAR_DODGE` | `SCREEN` is gentler and never clips to white |
| `name` | `Glow` | group name |

```js
const line = h.node(args.id);
h.glow(line, { radius: 40, intensity: 1.6, spread: 0.4, color: '#ff2bd6' });
```
Tips:
- Put the object on a dark background; additive glow is invisible on white.
- Glow the shape, not its parent frame, so it follows the neon only. Frames that clip content will clip the haze.
- For a hot white core on a coloured glow, keep the original node white (or lighter) and give `glow` a `color`.
- Delete or re-run: remove the returned group, then call `h.glow` again with new numbers.
- There is no brightness threshold (Figma cannot isolate highlights): glow comes from the whole node, so apply it to the layers that should glow.

## `h.iso(node, face, {scale})`: isometric projection
`face` is `'top'` (floor), `'left'` or `'right'` wall. Edges run at ±30°, lengths are preserved. Applied around the node centre; apply it once per node (calling it again compounds). Build a cube by projecting three flat rectangles and aligning them by position.

```js
const top = h.iso(h.node(args.top), 'top');
```

## `h.transform(node, [a, b, c, d])`: any affine warp
`x' = a·x + c·y`, `y' = b·x + d·y`, around the node centre. Skew X by angle t: `[1, 0, Math.tan(t), 1]`. Skew Y: `[1, Math.tan(t), 0, 1]`. Flip: `[-1, 0, 0, 1]`.
Figma only supports affine matrices, so a true perspective (converging lines) is not possible on a live layer; approximate it with a trapezoid vector path.
