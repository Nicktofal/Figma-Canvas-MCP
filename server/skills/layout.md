# Layout: Auto Layout, GRID, HTML mapping

```js
const f = figma.createFrame();
f.layoutMode = 'VERTICAL';             // 'HORIZONTAL' | 'GRID'; layoutWrap = 'WRAP' for wrapping rows
f.itemSpacing = 16; f.paddingTop = f.paddingBottom = 24; f.paddingLeft = f.paddingRight = 24;
f.primaryAxisAlignItems = 'MIN';       // MIN | CENTER | MAX | SPACE_BETWEEN
f.counterAxisAlignItems = 'MIN';       // MIN | CENTER | MAX | BASELINE
f.layoutSizingHorizontal = 'FIXED';    // FIXED | HUG | FILL (FILL needs an auto-layout parent)
child.layoutPositioning = 'ABSOLUTE';  // out of flow: badges, overlays
child.minWidth = 100; child.maxWidth = 480;
```

Native GRID: `f.layoutMode = 'GRID'` (a new GRID frame is 100×100 FIXED: resize first), `gridColumnCount/gridRowCount`, `gridColumnGap/gridRowGap`, `gridColumnSizes = [{type:'FIXED'|'FLEX'|'HUG', value}]`; per child `setGridChildPosition(row, col)`, `gridColumnSpan/gridRowSpan` (fails if neighbouring cells are occupied), `gridChildHorizontalAlign/VerticalAlign`. Children added later fill free cells in order.

`render_html` mapping:
- flex → Auto Layout (gap, padding, align, grow/stretch, wrap); CSS grid → native GRID (fr/px/auto tracks, spans; `auto-fill` falls back to absolute)
- block flow → vertical Auto Layout (uneven margins become "spacing" wrappers); `position:absolute` → ABSOLUTE child
- `transform` → rotation/scale on a wrapper; `clip-path` → mask; `::before/::after` and list markers → layers; `overflow:hidden` → clip
- `data-figma-component="Card"` on repeated elements → one component + instances; `bindVariables:true` binds matching values to local variables/text styles

Write flex + gap + padding in the HTML; avoid margins, floats and `auto-fill` grids for clean output. Always read the returned `warnings`.
