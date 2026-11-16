# Effects: gradient mesh (curved, Illustrator-style)

`await h.mesh(node, spec)` fills a layer with a gradient mesh: a grid of **nodes** (position + colour + optional bezier handles) joined by smooth bicubic patches. Grid lines can be curved, nodes can sit anywhere, colours blend smoothly (Oklab). The result is an image fill, so the layer keeps its outline, strokes, effects and corner radius; shapes of any outline (petal, leaf, cheek, sky) are filled by giving that shape a mesh.

## Spec
| field | meaning |
|---|---|
| `cols`, `rows` | node counts, each ≥ 2 (a 3×3 grid = 2×2 patches). Max 4096 nodes |
| `colors` | row-major list of colours (`'#hex'`, `[r,g,b,a]` 0–1) or a 2D array (rows of columns). Nodes then sit on a regular grid |
| `nodes` | row-major list of `{x, y, color, alpha, hl, hr, hu, hd}`; 2D arrays work too. `x`,`y` are **fractions of the layer's box** (0–1; may leave the box, the fill is clipped to it). Missing `x`,`y` fall back to the regular grid, so you can move only some nodes |
| `hr`,`hl`,`hd`,`hu` | bezier handle offsets `[dx, dy]` (same fractions) toward the right / left / down / up neighbour. They bend the grid line leaving that node. Give one handle and the opposite one mirrors it (smooth); give both for a corner |
| `from` | a layer (node or id): node colours are sampled from its pixels at the node positions. `h.mesh(n, {cols: 20, rows: 20, from: ref})` is a quick way to reproduce a picture; move nodes along its contours to follow shapes |
| `wrap` | `'u'` closes every row into a loop (columns wrap around), `'v'` closes the columns, `'uv'` both. For discs, rings, spheres, tubes |
| `smooth` | 0–1.5, default 1: roundness of the grid lines (auto tangents, Catmull-Rom). 0 = straight lines between nodes |
| `colorSmooth` | 0–1.5, default 1: colour continuity across node lines. Lower it for firmer colour bands |
| `space` | `'oklab'` (default, cleaner mixes) or `'srgb'` (what Illustrator does) |
| `scale` | image pixels per layer px (default 2, capped at 2048 px on the long side) |
| `append` | `true` adds the mesh above the layer's existing fills (default replaces them). Re-running on the same layer swaps its mesh in place |

Alpha per node (`alpha` or the 4th colour value) makes parts transparent. Outside the patches the image is transparent.

```js
// 1. soft background: 4×3 colours, nothing else
await h.mesh(h.node(args.bg), { cols: 4, rows: 3, colors: [
  '#ffd29d','#ff9a8b','#c86dd7','#5b3fd0',
  '#ffe6b0','#ff7f9e','#8e5be0','#2c2a8f',
  '#fff3c9','#ff6f91','#6a4bd9','#171a5c'] });

// 2. a curved grid: move nodes and bend lines with handles
const nodes = [];
for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) {
  nodes.push({ x: c / 4, y: r / 3 + 0.08 * Math.sin(c * 1.4), color: palette[r][c],
               hr: [0.08, 0.04 * Math.cos(c)], hd: [0, 0.1] });
}
await h.mesh(h.node(args.layer), { cols: 5, rows: 4, nodes });

// 3. a shaded ball: a circle of nodes whose first row collapses to the centre (wrap 'u')
const cols = 8, rows = 4, ball = [];
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
  const a = c / cols * Math.PI * 2, rad = r / (rows - 1) * 0.5;
  ball.push({ x: 0.5 + rad * Math.cos(a), y: 0.5 + rad * Math.sin(a), color: shade(a, r / (rows - 1)) });
}
await h.mesh(h.node(args.ellipse), { cols, rows, nodes: ball, wrap: 'u' });
```

## Editing
`h.meshGet(node)` returns the stored spec (`nodes[i].c` is `[r,g,b,a]`); `await h.meshUpdate(node, patch)` changes it and re-renders: `{colors: [...]}`, `{smooth: .5}`, or `{nodes: [{color:'#fff'}, {}, …]}` where each entry is merged into the existing node (same grid size).

## Limits
- Figma stores at most 100 kB of plugin data per layer entry. The mesh spec is kept there (compactly) so `h.meshGet` / `h.meshUpdate` work; very large meshes (roughly 1500+ nodes) exceed it and then **drop the stored nodes**: the mesh still renders, only `h.meshGet` / `h.meshUpdate` stop working (`tooBig`). Workaround: keep the spec in your own script and call `h.mesh` again to change it, or use fewer nodes. Rarely do you need more than a few hundred.
- Ring meshes (`wrap`) need few columns (32–96) but many rows only near sharp features; spend rows where colour changes fast (an edge rim), not evenly.
- The image is rendered at `scale` px per layer px, at most 4096 px per side and 12 M pixels in total.

## How to get a realistic result
- Use the shape's own outline: one mesh per shape (petal, cheek, sky band), as in an Illustrator illustration. Fill the layer, do not put a mesh over everything.
- Put nodes where the colour changes (highlight, core shadow, reflected light), not on a uniform grid. A few well-placed nodes beat many.
- Make grid lines follow the form: handles along the surface direction (a cylinder's lines run along its length, a sphere's wrap around it).
- Keep neighbouring nodes in order: crossing or folded grid lines give creases.
- Prototype at low `scale`, check the screenshot, then raise it. Needs the plugin window open (rendering happens there).
