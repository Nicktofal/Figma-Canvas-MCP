# Effects: grain, progressive blur, halftone

Helpers on `h` inside `execute`. Grain and progressive blur are **native Figma effects** (live, editable in the Effects panel); halftone builds one vector.

## `h.grain(node, opts)`: film grain / noise
Frames, components, instances, rectangles and groups get a full-size overlay layer named "Grain" (neutral grey, blend OVERLAY, NOISE effect) so only the grain shows over whatever is below. Other shapes get the NOISE effect directly (it only renders over a visible fill).

| option | default | meaning |
|---|---|---|
| `amount` | 0.35 | grain strength (alpha 0–1). 0.1–0.2 subtle film, 0.5+ heavy |
| `size` | 1 | grain size in px. 1 = fine, 2–3 = coarse |
| `density` | 0.6 | share of pixels with grain, 0–1 |
| `tone` | `duo` | `duo` = dark + light specks (balanced), `mono` = one colour |
| `color`, `color2` | black, white | grain colours (hex); mono uses `color` |
| `blend` | `OVERLAY` | `SOFT_LIGHT` is gentler, `HARD_LIGHT` stronger (overlay mode only) |
| `mode` | by type | force `'overlay'` or `'direct'` |

```js
h.grain(h.node(args.frame), { amount: 0.18, size: 1.2 });
```
Put it above everything it should cover (it is added as the topmost child of a frame). To grain only an image, group or frame it first. Noise does not show over a fill with opacity ~0; that is why the overlay uses solid grey.

## `h.progressiveBlur(node, opts)`: blur that ramps along an axis
`side` is where the blur is strongest: `'bottom'` (default), `'top'`, `'left'`, `'right'`. `radius` (default 24) is the strongest blur, `startRadius` (0) the weak end, `from`/`to` (0–1, default 0 and 1) where the ramp begins and ends along the node. `background:true` blurs what is behind the node (frosted header that fades out) instead of the layer. `replace:true` removes existing blurs first.
```js
h.progressiveBlur(h.node(args.photo), { side: 'bottom', radius: 32, from: 0.4 });
```

## `await h.halftone(node, opts)`: halftone from the layer's pixels
Samples the layer and returns ONE vector of dots/squares/lines on a rotated grid. The original is hidden unless `keep:true`.

| option | default | meaning |
|---|---|---|
| `cell` | 8 | grid pitch in px (raised automatically past ~12000 dots) |
| `shape` | `dot` | `dot`, `square`, `diamond`, `line` |
| `angle` | 45 (0 for lines) | grid rotation, degrees |
| `color` | `#000000` | ink hex; `'source'` = one ellipse per dot in the layer's own colours (max ~3000) |
| `invert` | false | false: dark areas get big dots (ink on light paper). true: light areas get big dots (light dots on a dark background) |
| `gamma`, `contrast` | 1, 1 | gamma < 1 grows dots, contrast stretches the tones |
| `max` | 1.05 | largest dot as a share of the cell |
| `bg` | none | hex: adds a background rectangle (result becomes a group) |

```js
await h.halftone(h.node(args.photo), { cell: 6, color: '#111', bg: '#f4efe6' });
await h.halftone(h.node(args.photo), { cell: 7, invert: true, color: '#ff4d8d', bg: '#0b0b12', shape: 'dot' });
```
Dot area follows tone, so mid-greys read correctly. Needs the plugin window open (pixels are decoded there).
