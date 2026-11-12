# Effects: glass, blur, noise, shadows

## Supported by `render_html` directly
- `box-shadow` (multiple, inset, spread) → DROP_SHADOW / INNER_SHADOW
- `filter: blur(8px)` → LAYER_BLUR (Figma radius = 2 × CSS px)
- `backdrop-filter: blur(12px)` → BACKGROUND_BLUR
- gradients (`linear`, `radial`; `conic` approximated), `opacity`, `border`, `border-radius`
- `data-figma-effects='[{"type":"…", …}]'` appends raw Figma effect objects to a node (use for newer effect types).

## Frosted-glass recipe (works in every file)
```html
<div style="background:linear-gradient(135deg,rgba(255,255,255,.28),rgba(255,255,255,.06));
            backdrop-filter:blur(20px); border:1px solid rgba(255,255,255,.35);
            border-radius:24px; box-shadow:0 8px 32px rgba(0,0,0,.25); padding:24px">…</div>
```
Put it over a colorful/gradient/photo background so there is something to blur.

## Native Figma Glass effect (verified in the Plugin API)
Schema read from a real layer — assign it directly:
```js
node.effects = [{
  type: 'GLASS', visible: true,
  radius: 4,            // frost / blur amount
  refraction: 0.8,      // 0–1 bending of the background
  depth: 100,           // edge thickness of the lens
  lightAngle: -45,      // degrees
  lightIntensity: 0.8,  // 0–1
  dispersion: 0.5,      // 0–1 chromatic split
  splay: 0,
}];
```
Typical glass layer: a rounded rectangle/frame with a low-opacity fill (e.g. `#D9D9D9` @ 0.2) + the GLASS effect, placed over a colorful background. Works from HTML too:
`<div data-figma-effects='[{"type":"GLASS","visible":true,"radius":4,"refraction":0.8,"depth":100,"lightAngle":-45,"lightIntensity":0.8,"dispersion":0.5,"splay":0}]'>…</div>`

Other new types (NOISE, TEXTURE): feature-detect by reading a hand-made sample (`read` returns unknown effect types with a `raw` field), then copy the shape. If assignment throws, fall back to the CSS recipe above.

## Noise / grain
Use `render_shader` with a hash-noise fragment shader, then lower its opacity / set an overlay blend mode:
`execute` → `node.fills = node.fills.map(f => f.type==='IMAGE' ? {...f, blendMode:'OVERLAY', opacity:0.15} : f)`.

## Effects via execute
```js
node.effects = [
  {type:'DROP_SHADOW', color:{r:0,g:0,b:0,a:0.25}, offset:{x:0,y:8}, radius:24, spread:0, visible:true, blendMode:'NORMAL'},
  {type:'BACKGROUND_BLUR', radius:20, visible:true},
];
```

## More native effects (verified)
- `{type:'NOISE', noiseType:'MONOTONE', noiseSize:2, density:0.5, color:{r,g,b,a}, visible:true}`: no `blendMode` key allowed.
- `{type:'TEXTURE', noiseSize:2, radius:4, clipToShape:true, visible:true}`
- Progressive blur: `{type:'LAYER_BLUR', blurType:'PROGRESSIVE', startRadius:0, radius:20, startOffset:{x:.5,y:0}, endOffset:{x:.5,y:1}, visible:true}`
All of these also work through `data-figma-effects` in `render_html`, and can be keyframed with `motion` (e.g. prop `effects[0].RADIUS`).
