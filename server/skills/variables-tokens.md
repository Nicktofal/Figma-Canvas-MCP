# Variables & design tokens

Read first: `read` target `file` lists collections, modes, variables and paint/text/effect styles.

```js
// create
const col = figma.variables.createVariableCollection('Brand');
const modeId = col.modes[0].modeId;
const primary = figma.variables.createVariable('color/primary', col, 'COLOR');
primary.setValueForMode(modeId, {r:0.39,g:0.4,b:0.95,a:1});
// bind to a fill
const paint = figma.variables.setBoundVariableForPaint({type:'SOLID',color:{r:0,g:0,b:0}}, 'color', primary);
node.fills = [paint];
// bind a number (spacing, radius, gap…)
node.setBoundVariable('itemSpacing', spaceVar);   // also paddingTop…, cornerRadius, width, height…
// paint style
const s = figma.createPaintStyle(); s.name = 'Brand/Primary'; s.paints = [paint];
await node.setFillStyleIdAsync(s.id);
```
- Aliases: `variable.setValueForMode(modeId, figma.variables.createVariableAlias(otherVar))`.
- Dark mode: `col.addMode('Dark')`, set values per mode, switch a frame with `frame.setExplicitVariableModeForCollection(col, modeId)`.
- When converting an HTML design, create variables first, then after `render_html` run an `execute` pass that rebinds fills/spacings matching token values.
- Shortcut: `render_html {bindVariables:true}` binds fills, strokes, gaps, paddings, radii and font sizes that equal a local variable value (scopes respected) and matching text styles. Helpers in `execute`: `h.vars()`, `h.bind(node, 'fill'|'itemSpacing'|…, 'color/brand')`.
- Library tokens: `library {op:'collections'}` → `variables` → `import_variable`.
