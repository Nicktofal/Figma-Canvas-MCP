# Research: boundaries of Figma MCP with HTML

Date: 2026-11-08. Environment: Figma desktop, file "Draft", page "Dev". Every item below was run against the real Plugin API through the bridge unless marked **(not live-tested)**. Evidence is left on the **Dev** page (frames named `Research / …`, `Anim / …`, `Perf / …`).

Legend: ✅ works · ⚠️ works with caveats · ❌ not possible · 🐞 bug in this project (fixed = fixed in code, needs plugin reload)

---

## 1. Verified capabilities

### Undo / checkpoints — ✅ solved without UI
| Mechanism | Result |
|---|---|
| `figma.commitUndo()` + `figma.triggerUndo()` | Real transactional undo. Verified: boundaries made with `commitUndo` are undone one step at a time, **also across separate `execute` calls**; creating a node, moving it and rotating it were rolled back step by step (3 steps → 3 `triggerUndo`). |
| Rolling back a whole animation loop | 8 iterations of property mutations **with `await exportAsync` inside** → ONE `triggerUndo` restored the original state. |
| `figma.saveVersionHistoryAsync(title, description)` | ✅ creates a named, user-visible version in file history (one was created: "MCP research checkpoint"). Cannot be restored via API — only by the user in the UI. |
| `figma.on('documentchange')` | ✅ gives CREATE / PROPERTY_CHANGE / DELETE with node id and **list of changed property names**, origin LOCAL/REMOTE. ❌ no old values → cannot build an undo from it alone. |
Caveats: the undo stack is shared with the human. `triggerUndo` can undo the user's own actions if the bridge counts boundaries wrong or the user edited in between. Needs an own journal (count of boundaries the bridge created + guard).

### Blend modes — ✅ complete
All 18 modes set and rendered correctly on **node level** (NORMAL, DARKEN, MULTIPLY, LINEAR_BURN, COLOR_BURN, LIGHTEN, SCREEN, LINEAR_DODGE, COLOR_DODGE, OVERLAY, SOFT_LIGHT, HARD_LIGHT, DIFFERENCE, EXCLUSION, HUE, SATURATION, COLOR, LUMINOSITY). Also works at **paint level** (`fills[i].blendMode`) and **effect level** (`DROP_SHADOW.blendMode = 'COLOR_DODGE'`). See frames `Research / Blend modes…` and `Research / Paint-level…`.

### Native GRID auto layout — ✅ (big finding)
`frame.layoutMode = 'GRID'` exists with a full API: `gridRowCount/ColumnCount`, `gridRowGap/ColumnGap`, `gridColumnSizes/gridRowSizes` (`{type:'FLEX'|'FIXED'|'HUG', value}`), `gridColumnSizingCSS` (getter returns e.g. `minmax(0,1fr) minmax(0,2fr) 80px`; setter accepted but normalised), child `gridColumnSpan/gridRowSpan`, `gridColumnAnchorIndex/gridRowAnchorIndex`, `setGridChildPosition()`, `gridChildHorizontalAlign/VerticalAlign`, `gridAutoTracks`, `gridItemsPositioning`. Setting a span fails if adjacent cells are occupied (`Cannot set child to specified column span due to existing children in adjacent columns`). A new GRID frame defaults to 100×100 FIXED — size it explicitly. **`render_html` still converts CSS grid to absolute layers** → this should be replaced by native GRID (see §4).

### Animation capture (offline rendering) — ⚠️ feasible, prototype built
- Frame export speed (960×540 PNG, ~123 KB): **≈116 ms/frame average (max 170 ms)** → 30 frames ≈ 3.5 s, a 5 s @ 60 fps clip ≈ 35 s render.
- Export limits: PNG@4x of a 1000×600 frame 773 ms; **8000×8000 PNG exported fine (4.3 s)**; SVG, PDF, JPG export all work.
- Prototype implemented: plugin method `capture` + server tool `capture_animation` (frames → PNG sequence on disk → ffmpeg → mp4 / webm / gif). Server side (writing frames, mp4/gif/webm encoding with bundled `ffmpeg-static` 6.1) **tested end-to-end with a fake plugin**; plugin side `capture` (per-frame `code(figma,node,i,t,n)`, export, rollback with one `triggerUndo`) **not live-tested yet** (needs Claude Code + plugin restart). Pieces proven live: per-frame mutation + export loop, single-step rollback.
- Prototype playback (Smart Animate) **cannot** be played/recorded through the API → motion has to be computed by our own interpolation (position/size/rotation/opacity/fills/effects/radius per frame).
- `figma.createVideoAsync` exists (typeof function) **(not live-tested)** → possible to place the encoded mp4 back into Figma as a video fill, closing the loop.

### Vector / shape / text — ✅
`figma.flatten([text])` (text → vector outlines), `figma.subtract/union/intersect/exclude`, `line.outlineStroke()`, `vectorNetwork` with per-vertex stroke caps and dashes, masks (`isMask`), all gradient types (`LINEAR/RADIAL/ANGULAR/DIAMOND`), `createNodeFromSvg`, sections, annotations (`node.annotations = [{label}]`, categories: Development, Interaction, Accessibility, Content), `figma.group` (real GROUP).
⚠️ **Mask order:** the mask layer must be the **first child (bottom)** of its group; mask on top of the content does nothing (first attempt failed because of this).

### Plugin infrastructure
- `execute` through `new AsyncFunction` works in the real sandbox ✅.
- Plugin data on the document (`setPluginData`) ✅ — usable for a persistent change journal.
- Perf: 2000 rectangles created in **4.8 s** (~2.4 ms/node), `findAll` over 2000 nodes **14 ms**, bulk property edit of 2000 nodes **0.2 s**.

---

## 2. Hard limits (cannot be done through the Plugin API)
| Limit | Evidence / consequence |
|---|---|
| Image bytes > 4096 px | `figma.createImage` → `Image is too large` (5000×5000). Resize/tile in the UI canvas first. |
| Missing font | `loadFontAsync` throws `The font "X Regular" could not be loaded` — must resolve fonts before building (the converter already does via `listAvailableFontsAsync`). |
| FigJam / Slides APIs | `createConnector`, `createSlide` are not functions in a design file. |
| Manifest permissions required | `figma.currentUser` → needs `"currentuser"`, `figma.activeUsers` → `"activeusers"`, `figma.teamLibrary` → `"teamlibrary"`. Easy to add to `manifest.json` but not enabled yet. |
| `figma.fileKey` | `undefined` for non-published/private dev plugins. |
| Other plugins | Only one plugin runs at a time. |
| Figma UI chrome | No menus, comments, version restore, publish, Dev Mode. |
| Prototype playback / recording | Not accessible. |
| Calls | MCP calls are effectively **serialized** (two parallel `execute` calls ran one after the other). |
| Timers | `setTimeout` in the plugin **jitters/throttles** (200 ms sleeps took up to 1 s while the window was not focused). Never time animation by wall clock; drive frames by index. |
| Variable fonts / OpenType | `fontVariations` property absent; `openTypeFeatures` readable (`{}`); text-on-path absent. |

---

## 3. Bugs and gaps found in this project (converter `render_html`)
Test files: `Research / Tailwind landing`, `Research / CSS stress test` on Dev.

**Fixed in code (need plugin reload to take effect):**
- 🐞 Font stack picked an emoji font: Tailwind `font-sans` ends with `"Apple Color Emoji","Segoe UI Emoji"` and the first installed family won → whole page rendered in "Segoe UI Emoji Regular". Emoji/symbol families are now skipped; generic stacks map to Inter.
- 🐞 `text-transparent bg-clip-text` gradient text was invisible (alpha-0 text). `background-clip:text` + gradient is now converted to a gradient text fill (approximation: the gradient spans the text node, not the individual span).
- 🐞 `min-h-screen`/`vh` resolved against an arbitrary 3000 px iframe (root came out 3000 px tall). New `viewportHeight` parameter (default 900).

**Still open — features silently lost (no warning):**
`transform` (rotate/scale: bounding box is used instead; shapes come out wrong), `mix-blend-mode` (**API supports it — see §1**), `clip-path` (ignored), `filter` other than `blur`/`drop-shadow` (e.g. grayscale ignored), `outline`/`outline-offset`, `background-repeat` / SVG data-URI backgrounds, list markers (bullets/numbers), `object-fit:none`, `position:sticky`, CSS columns (renders as one text block).
Warned but approximated: CSS grid → absolute layers, `::before/::after` content ignored, conic-gradient → angular gradient, mixed block layout → absolute.
Supported and verified: text-shadow, multi-shadow, inset shadow, gradients, backdrop-blur, per-corner radii, dashed borders, mixed text runs, SVG, images, inline-block, flex wrap, absolute positioning.

Also: every Tailwind/real page produces a **flat naming** (`div`, `button`); semantic layer names from classes/ids/roles would help.

---

## 4. Extension candidates (ranked by value / effort)
1. **Transactional edits:** `checkpoint` / `undo(n)` / `redo`-less rollback tool built on `commitUndo`/`triggerUndo` + a journal (stored via `setPluginData`) that counts bridge-owned boundaries and refuses to undo user actions. Optional auto-checkpoint before every `execute`, plus `saveVersionHistoryAsync` before big runs. Very high value, small effort.
2. **Finish animation capture:** live-test `capture`; add declarative keyframes (`tracks: [{target, prop, from, to, easing}]`) so agents don't hand-write interpolation; easing library; per-frame `exportAsync` scale/format; audio-free mp4 placed back with `createVideoAsync`; frame-diff to skip duplicate frames; background rendering without blocking the plugin UI (progress events).
3. **Replace CSS grid fallback with native `layoutMode = 'GRID'`** (track sizes from `grid-template-*`, spans from `grid-column/row`, gaps).
4. **Converter fidelity:** `mix-blend-mode` → `blendMode`; `transform` → rotation/scale on correctly-sized nodes; `clip-path` → masks/vector; `filter: grayscale/brightness…` → effects/blend tricks; `outline` → outer stroke/extra layer; list markers; `background-repeat` → tiled image fill (`scaleMode: 'TILE'`); and **emit warnings for every ignored property** instead of dropping silently.
5. **Reverse direction (Figma → HTML/CSS/React):** `get_dev_css`-style export using the same data (auto layout → flex, GRID → grid, effects → CSS). Pair with the screenshot-diff harness to score fidelity round-trip.
6. **Permissions:** add `currentuser`, `teamlibrary` (library components/variables discovery), maybe `activeusers`/`fileusers` to the manifest; expose `import_library_component`.
7. **Disk export tool:** `export` (SVG/PDF/PNG/JPG of any node, up to 8000 px) writing straight to the project folder — trivially unlocked by the same frame-transfer code used by `capture`.
8. **Structure & naming:** semantic layer names, auto-grouping of logically related shapes (currently only in the skill), component detection for repeated structures during `render_html`.
9. **Reliability:** request queue/timeouts with progress, chunked transfer for big payloads, reconnect handling of in-flight calls, multi-file/page targeting.
10. **Verification harness:** automated visual regression (screenshot HTML in a browser vs. screenshot of the generated Figma frame, pixel diff) to measure converter quality continuously.

---

## 5. Not yet tested / suggested next experiments
- Live test of `capture_animation` (needs restart) incl. 60 fps × 5 s, rollback correctness on groups/instances/auto-layout nodes, memory/message size of ~300 frames over the WebSocket.
- `createVideoAsync` with the encoded mp4; fill type `VIDEO`.
- Component / variant creation at scale and `importComponentByKeyAsync` (needs `teamlibrary`).
- Auto-layout interplay of `triggerUndo` with `layoutSizing*` changes.
- Behaviour with 10k+ node pages and multi-page files; `loadAllPagesAsync` cost.
- Reading images/fills as bytes (`image.getBytesAsync`) for analysis; pixel colour sampling via small exports.
- Variable modes switching (light/dark) as the animation axis.

---

## 6. Round 2 (2026-11-08): new API surface and v0.2.0 results

All items live-tested through the bridge (Draft → Dev page; test frames `Research / Converter v2`, `Motion / Demo`, `Motion / Demo 2`).

### Newly discovered Plugin API surface
| API | Result |
|---|---|
| **Native motion timeline** — `node.applyManualKeyframeTrack(field, {keyframes:[{timelinePosition, value:{type,value}, easing?}]})`, `removeManualKeyframeTrack`, `manualKeyframeTracks`, `timelines`, `setTimelineDuration(id, s)`, `playbackSettings {autoplay,loop,muted}` | ✅ Fields: OPACITY, TRANSLATION_X/Y/XY, ROTATION, SCALE_X/Y/XY (XY = VECTOR value), WIDTH, HEIGHT, CORNER_RADIUS (+ per corner), STROKE_WEIGHT (+ per side), STACK_SPACING/PADDING_*/COUNTER_SPACING, GRID_ROW/COLUMN_GAP, PATH_TRIM_START/END; INDEXED_ITEM effects fields (RADIUS, OFFSET_X/Y, SPREAD, COLOR, glass/noise params…). Value types FLOAT, COLOR, VECTOR, BOOL, TEXT_DATA, … Timeline belongs to the top-level frame (default 2 s). Fill colour tracks need a `propertyId` from the paint's property definitions (not found yet). |
| **Animation presets** — `figma.motion.figmaAnimationStyles()`, `node.applyAnimationStyle(styleId, props, {timelineOffset})`, `removeAnimationStyle(id)`, `figma.createCustomAnimationStyle()` | ✅ 7 presets: TextStagger, Position, Scale, Rotation, Size, Opacity, Path. Prop names accepted differ from the descriptions (validation errors list unknown keys). |
| **Native video export** — `exportAsync({format:'MP4'|'GIF'|'WEBM', fps:12|24|30|60, quality:'LOW'|'MEDIUM'|'HIGH', constraint:{SCALE 0.5–4 | WIDTH | HEIGHT}})` | ✅ Renders the timeline incl. presets (2 s 480×270 MP4 ≈ 3.3 s). ⚠️ Fails with "Video export failed" when the Figma window is in the background; "Cannot export node as video" when there is no animation. PNG export ignores the timeline (shows the static state). |
| `figma.createVideoAsync` | ❌ "Uploading videos only works for files in a paid Pro team that are not in your Drafts". |
| `node.getCSSAsync()` | ✅ Figma's Dev-Mode CSS per layer (flex, grid with spans, effects, `var(--token, fallback)`); omits left/top for children of non-auto-layout frames. Basis of `to_code`. |
| `exportAsync({format:'JSON_REST_V1'})` | ✅ REST-API JSON of a node without a token. |
| New effects | ✅ NOISE (no `blendMode` key!), TEXTURE, GLASS, LAYER_BLUR `blurType:'PROGRESSIVE'` with start/end offsets. |
| Fill type `SHADER` | ⚠️ Exists; needs an id from `figma.listAvailableShaders()` (empty in this file) / `importShaderById`. |
| Text | ✅ `setRangeListOptions` (bullets/numbers), `setRangeHyperlink`, `textTruncation` + `maxLines`, `paragraphSpacing`, `leadingTrim`, `createTextPath(shape, …)`. `getFontFamilyVariationAxes('Inter')` → `['slnt','wght']` but no setter for variation values. |
| Other | `figma.loadBrushesAsync('STRETCH'|'SCATTER')`, `variableWidthStrokeProperties`, `complexStrokeProperties`, `figma.transformGroup`, `createSlice`, `createPageDivider`. `createNodeFromJSXAsync` exists but throws internally. `figma.codegen` needs the codegen capability (do not touch it otherwise — the property getter throws). |
| `documentchange` / `nodechange` | ❌ No events are delivered in this setup (neither for plugin nor across calls) → user-edit detection uses an undo-sentinel instead. |
| Undo | ✅ `setPluginData` is undoable → a per-operation sentinel makes every bridge call one identifiable undo step; rollback on error = `commitUndo(); triggerUndo()`. Interleaved (parallel) calls break step boundaries → the plugin now serialises all commands. |

### Implemented in v0.2.0 (all verified live)
- `history` (undo n / undo to seq, refuses to undo manual edits, version checkpoints); `execute`/`render_html` atomic rollback on error; command queue.
- `render_html`: native GRID (fr/px/auto, spans, alignment), transforms (rotation sign verified: CSS 20° → Figma −20°), clip-path → vector masks, mix/background blend modes, outline → OUTSIDE stroke or ring shadow, pseudo-elements and list markers materialised as layers, ellipsis/line-clamp, hyperlinks, tiled backgrounds, object-fit, CSS colour filters baked into bitmaps, image downscale > 4096 px, semantic layer names, `data-figma-component` → component + instances with overrides, `bindVariables` (colours, gap/padding, radii, font sizes, text styles), animations disabled while measuring, missing-font warnings.
- `motion` (tracks, presets, timeline/playback), `export` (incl. native MP4/GIF/WEBM), `capture_animation` with declarative tracks + easing library + native-timeline evaluation (matches Figma's own render within ~2 px), `to_code` (HTML / JSX), `compare` (pixel diff with hotspots), `library`, `page`, `figma_rest`, multi-file connections, progress notifications, keepalive.

### Remaining hard limits
Prototype playback; UI chrome (menus, comments — use `figma_rest`, version restore, publishing); other plugins; video upload outside paid teams; variable-font axis values; fill-colour keyframes (property id unknown); SHADER fills without available shaders.
