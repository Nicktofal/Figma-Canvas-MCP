// Figma Canvas MCP — plugin main thread (has the `figma` global, no network).
// The UI iframe (ui.html) owns the WebSocket and the DOM; this file executes commands on the canvas.

figma.showUI(__html__, { width: 320, height: 500, themeColors: true });

figma.clientStorage.getAsync("port").then(function (port) {
  figma.ui.postMessage({ type: "config", port: port || 3055 });
});

// ───────────────────────── helpers ─────────────────────────

var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function round(n) {
  return Math.round(n * 100) / 100;
}

function hex(c) {
  function h(v) {
    var s = Math.round(v * 255).toString(16);
    return s.length < 2 ? "0" + s : s;
  }
  return "#" + h(c.r) + h(c.g) + h(c.b);
}

function simplifyPaint(p) {
  if (p.type === "SOLID") {
    var o = { type: "SOLID", color: hex(p.color) };
    if (p.opacity !== undefined && p.opacity !== 1) o.opacity = round(p.opacity);
    if (p.visible === false) o.visible = false;
    if (p.boundVariables && p.boundVariables.color) o.variable = p.boundVariables.color.id;
    return o;
  }
  if (p.type.indexOf("GRADIENT") === 0) {
    return {
      type: p.type,
      stops: p.gradientStops.map(function (s) {
        return { at: round(s.position), color: hex(s.color), a: round(s.color.a) };
      }),
    };
  }
  if (p.type === "IMAGE") return { type: "IMAGE", scaleMode: p.scaleMode };
  return { type: p.type };
}

function simplifyEffect(e) {
  var o = { type: e.type };
  if (e.visible === false) o.visible = false;
  if (e.radius !== undefined) o.radius = e.radius;
  if (e.spread) o.spread = e.spread;
  if (e.offset) o.offset = e.offset;
  if (e.color) o.color = hex(e.color) + (e.color.a !== undefined && e.color.a !== 1 ? "@" + round(e.color.a) : "");
  // Unknown/new effect types (glass, noise, texture…): pass raw data through so the agent can see the schema.
  if (["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"].indexOf(e.type) < 0) o.raw = ser(e, 3);
  return o;
}

/** Make any value JSON-safe. Nodes become {id,name,type}. */
function ser(v, depth) {
  if (depth === undefined) depth = 6;
  if (v === undefined) return null;
  if (v === null) return null;
  if (v === figma.mixed) return "<mixed>";
  var t = typeof v;
  if (t === "function") return "<function>";
  if (t === "symbol" || t === "bigint") return String(v);
  if (t !== "object") return v;
  if (v instanceof Uint8Array) return "<Uint8Array " + v.length + " bytes>";
  if (typeof v.id === "string" && typeof v.type === "string" && "name" in v) return { id: v.id, name: v.name, type: v.type };
  if (depth <= 0) return "<max depth>";
  if (Array.isArray(v)) return v.map(function (x) { return ser(x, depth - 1); });
  var out = {};
  for (var k in v) {
    try {
      out[k] = ser(v[k], depth - 1);
    } catch (e) {
      out[k] = "<error>";
    }
  }
  return out;
}

async function getNode(id) {
  var n = await figma.getNodeByIdAsync(id);
  if (!n) throw new Error("Node not found: " + id);
  return n;
}

async function exportNode(node, scale) {
  var maxDim = Math.max(node.width, node.height, 1);
  var s = Math.min(scale || 1, 2048 / maxDim);
  var bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: s } });
  return { nodeId: node.id, name: node.name, width: Math.round(node.width), height: Math.round(node.height), bytes: bytes };
}

function hexToRgba(h) {
  h = String(h).trim().replace(/^#/, "");
  if (h.length === 3 || h.length === 4) h = h.split("").map(function (c) { return c + c; }).join("");
  var n = parseInt(h.slice(0, 6), 16);
  if (!isFinite(n)) throw new Error("Bad hex color: #" + h);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
}

async function screenshotTargets(spec, scale) {
  var nodes = [];
  if (Array.isArray(spec)) {
    for (var k = 0; k < Math.min(spec.length, 6); k++) nodes.push(await getNode(spec[k]));
  } else if (typeof spec === "string") nodes = [await getNode(spec)];
  else if (figma.currentPage.selection.length) nodes = figma.currentPage.selection.slice(0, 3);
  else if (figma.currentPage.children.length) nodes = [figma.currentPage.children[figma.currentPage.children.length - 1]];
  var out = [];
  for (var i = 0; i < nodes.length; i++) out.push(await exportNode(nodes[i], scale));
  return out;
}

function nextFreeX(page, exclude) {
  var max = 0;
  var any = false;
  page.children.forEach(function (c) {
    if (c !== exclude && "x" in c) {
      any = true;
      max = Math.max(max, c.x + c.width);
    }
  });
  return any ? max + 100 : 0;
}

async function resolveParent(parentId) {
  if (!parentId) return figma.currentPage;
  var p = await getNode(parentId);
  if (!("appendChild" in p)) throw new Error("Node " + parentId + " cannot contain children");
  return p;
}

async function place(node, parentId, x, y) {
  var parent = await resolveParent(parentId);
  var auto = parent.type !== "PAGE" && "layoutMode" in parent && parent.layoutMode !== "NONE";
  var freeX = parent.type === "PAGE" ? nextFreeX(parent, node) : 0;
  parent.appendChild(node);
  if (!auto) {
    node.x = x !== undefined ? x : freeX;
    node.y = y !== undefined ? y : 0;
  }
  return parent;
}

// ───────────────────────── fonts ─────────────────────────

var FONT_INDEX = null;
var FONT_CACHE = {};
var WEIGHT_NAMES = {
  thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, book: 400,
  medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900,
};

async function loadFontIndex() {
  if (FONT_INDEX) return;
  var list = await figma.listAvailableFontsAsync();
  FONT_INDEX = {};
  var lower = {};
  list.forEach(function (f) {
    var fam = f.fontName.family;
    if (!FONT_INDEX[fam]) FONT_INDEX[fam] = [];
    FONT_INDEX[fam].push(f.fontName.style);
    lower[fam.toLowerCase()] = fam;
  });
  FONT_INDEX.__lower = lower;
}

function parseStyle(style) {
  var s = style.toLowerCase().replace(/[\s_-]/g, "");
  var italic = /italic|oblique/.test(s);
  var base = s.replace(/italic|oblique/g, "");
  var w = base === "" ? 400 : WEIGHT_NAMES[base];
  return { italic: italic, weight: w };
}

async function resolveFont(families, weight, italic, warnings) {
  await loadFontIndex();
  var key = families.join("|") + "/" + weight + "/" + italic;
  if (FONT_CACHE[key]) return FONT_CACHE[key];
  var family = "Inter";
  var found = false;
  for (var i = 0; i < families.length; i++) {
    var cand = FONT_INDEX.__lower[String(families[i]).toLowerCase()];
    if (cand) {
      family = cand;
      found = true;
      break;
    }
  }
  if (!found && warnings && families.join() !== "Inter") {
    var msg = "font not installed: " + families.join(", ") + " → Inter";
    if (warnings.indexOf(msg) < 0) warnings.push(msg);
  }
  var styles = FONT_INDEX[family] || ["Regular"];
  var best = styles[0];
  var bestScore = Infinity;
  styles.forEach(function (st) {
    var p = parseStyle(st);
    if (p.weight === undefined) return;
    var score = Math.abs(p.weight - weight) + (p.italic !== italic ? 1000 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = st;
    }
  });
  var fn = { family: family, style: best };
  await figma.loadFontAsync(fn);
  FONT_CACHE[key] = fn;
  return fn;
}

// ───────────────────────── build native nodes from the HTML tree ─────────────────────────

function runPaint(r) {
  if (r.gradient) {
    return {
      type: r.gradient.type,
      gradientTransform: r.gradient.gradientTransform,
      gradientStops: r.gradient.stops.map(function (s) {
        return { position: s.position, color: s.color };
      }),
    };
  }
  return paint(r.color);
}

function paint(c) {
  return { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a === undefined ? 1 : c.a };
}

async function makeFill(f) {
  var out;
  if (f.type === "SOLID") out = paint(f.color);
  else if (f.type === "IMAGE") {
    if (!f.bytes) return null;
    var img = figma.createImage(f.bytes);
    out = { type: "IMAGE", scaleMode: f.scaleMode || "FILL", imageHash: img.hash };
    if (f.scaleMode === "TILE") out.scalingFactor = f.scalingFactor || 1;
    if (f.scaleMode === "CROP") out.imageTransform = f.imageTransform || [[1, 0, 0], [0, 1, 0]];
  } else {
    out = {
      type: f.type,
      gradientTransform: f.gradientTransform,
      gradientStops: f.stops.map(function (s) {
        return { position: s.position, color: s.color };
      }),
    };
  }
  if (f.blendMode && f.blendMode !== "NORMAL") out.blendMode = f.blendMode;
  return out;
}

function Ctx() {
  this.warnings = [];
  this.count = 0;
  this.components = {};
}

function safe(ctx, label, fn) {
  try {
    fn();
  } catch (e) {
    if (ctx.warnings.indexOf(label + ": " + e.message) < 0) ctx.warnings.push(label + ": " + e.message);
  }
}

async function collectFonts(d, warnings) {
  if (d.kind === "text") {
    for (var i = 0; i < d.runs.length; i++) {
      var r = d.runs[i];
      r.font = await resolveFont(r.families, r.weight, r.italic, warnings);
    }
  } else if (d.children) {
    for (var j = 0; j < d.children.length; j++) await collectFonts(d.children[j], warnings);
  }
}

/** Insert the single shape of an SVG into `parent` at index, keeping its position relative to the SVG viewBox. */
function insertSvgShape(markup, parent, index) {
  var holder = figma.createNodeFromSvg(markup);
  var child = holder.children.length === 1 ? holder.children[0] : figma.flatten(holder.children.slice(), holder);
  var x = child.x, y = child.y;
  parent.insertChild(index, child);
  holder.remove();
  return { node: child, x: x, y: y };
}

async function buildNode(d, parent, ctx) {
  ctx.count++;
  var parentAuto = parent.type !== "PAGE" && "layoutMode" in parent && parent.layoutMode !== "NONE";
  var node;

  if (d.kind === "svg") {
    node = figma.createNodeFromSvg(d.markup);
    node.name = d.name || "svg";
    safe(ctx, "svg resize", function () {
      node.resize(Math.max(d.w, 0.01), Math.max(d.h, 0.01));
    });
    parent.appendChild(node);
    if (d.opacity !== undefined && d.opacity !== 1) node.opacity = d.opacity;
    applyCommon(node, d, parent, parentAuto, ctx);
    return node;
  }

  if (d.kind === "text") {
    node = figma.createText();
    var base = d.runs[0];
    node.fontName = base.font;
    node.characters = d.runs
      .map(function (r) {
        return r.text;
      })
      .join("");
    node.fontSize = base.fontSize;
    safe(ctx, "text color", function () {
      node.fills = [runPaint(base)];
    });
    if (d.lineHeight && d.lineHeight.unit === "PIXELS") node.lineHeight = d.lineHeight;
    safe(ctx, "letterSpacing", function () {
      if (base.letterSpacing) node.letterSpacing = { unit: "PIXELS", value: base.letterSpacing };
    });
    safe(ctx, "decoration", function () {
      if (base.decoration !== "NONE") node.textDecoration = base.decoration;
    });
    node.textAlignHorizontal = d.align;
    if (d.name) node.name = d.name; // after characters: setting a name turns off auto-rename
    var pos = 0;
    d.runs.forEach(function (r) {
      var s = pos;
      var e = pos + r.text.length;
      pos = e;
      if (e <= s) return;
      if (d.runs.length > 1) {
        safe(ctx, "run style", function () {
          node.setRangeFontName(s, e, r.font);
          node.setRangeFontSize(s, e, r.fontSize);
          node.setRangeFills(s, e, [runPaint(r)]);
          node.setRangeTextDecoration(s, e, r.decoration);
          node.setRangeLetterSpacing(s, e, { unit: "PIXELS", value: r.letterSpacing || 0 });
        });
      }
      if (r.href) {
        safe(ctx, "hyperlink", function () {
          node.setRangeHyperlink(s, e, { type: "URL", value: r.href });
        });
      }
    });
    if (d.fixedWidth) {
      node.resize(Math.max(d.w, 1), Math.max(d.h, 1));
      node.textAutoResize = "HEIGHT";
    } else {
      node.textAutoResize = "WIDTH_AND_HEIGHT";
    }
    if (d.maxLines) {
      safe(ctx, "truncation", function () {
        node.textTruncation = "ENDING";
        node.maxLines = d.maxLines;
      });
    }
    if (d.effects && d.effects.length) safe(ctx, "text effects", function () { node.effects = d.effects; });
    if (d.opacity !== undefined && d.opacity !== 1) node.opacity = d.opacity;
    parent.appendChild(node);
    applyCommon(node, d, parent, parentAuto, ctx);
    return node;
  }

  // frame
  node = figma.createFrame();
  node.name = d.name || "div";
  node.fills = [];
  node.clipsContent = !!d.clip;
  node.resize(Math.max(d.w, 0.01), Math.max(d.h, 0.01));

  var L = d.layout;
  if (L && L.mode === "GRID") {
    node.layoutMode = "GRID";
    safe(ctx, "grid", function () {
      node.gridRowCount = Math.max(1, L.rows.length);
      node.gridColumnCount = Math.max(1, L.cols.length);
      node.gridRowGap = L.rowGap || 0;
      node.gridColumnGap = L.colGap || 0;
      node.gridColumnSizes = L.cols;
      node.gridRowSizes = L.rows;
    });
    node.paddingTop = L.pad[0];
    node.paddingRight = L.pad[1];
    node.paddingBottom = L.pad[2];
    node.paddingLeft = L.pad[3];
  } else if (L && L.mode !== "NONE") {
    node.layoutMode = L.mode;
    node.itemSpacing = L.gap || 0;
    node.paddingTop = L.pad[0];
    node.paddingRight = L.pad[1];
    node.paddingBottom = L.pad[2];
    node.paddingLeft = L.pad[3];
    node.primaryAxisAlignItems = L.primary;
    node.counterAxisAlignItems = L.counter;
    if (L.wrap) {
      safe(ctx, "wrap", function () {
        node.layoutWrap = "WRAP";
        node.counterAxisSpacing = L.counterGap || 0;
      });
    }
  }

  var fills = [];
  for (var i = 0; i < d.fills.length; i++) {
    try {
      var pf = await makeFill(d.fills[i]);
      if (pf) fills.push(pf);
    } catch (e) {
      ctx.warnings.push("fill on " + node.name + ": " + e.message);
    }
  }
  node.fills = fills;

  if (d.stroke) {
    safe(ctx, "stroke", function () {
      node.strokes = [paint(d.stroke.color)];
      node.strokeAlign = d.stroke.align || "INSIDE";
      var w = d.stroke.weights;
      if (w[0] === w[1] && w[1] === w[2] && w[2] === w[3]) node.strokeWeight = w[0];
      else {
        node.strokeTopWeight = w[0];
        node.strokeRightWeight = w[1];
        node.strokeBottomWeight = w[2];
        node.strokeLeftWeight = w[3];
      }
      if (d.stroke.dash) node.dashPattern = d.stroke.dash;
    });
  }

  var rad = d.radius;
  if (rad && (rad[0] || rad[1] || rad[2] || rad[3])) {
    if (rad[0] === rad[1] && rad[1] === rad[2] && rad[2] === rad[3]) node.cornerRadius = rad[0];
    else {
      node.topLeftRadius = rad[0];
      node.topRightRadius = rad[1];
      node.bottomRightRadius = rad[2];
      node.bottomLeftRadius = rad[3];
    }
  }

  if (d.effects && d.effects.length) {
    try {
      node.effects = d.effects;
    } catch (e1) {
      try {
        node.effects = d.effects.map(function (ef) {
          return ef.type.indexOf("BLUR") >= 0 ? Object.assign({ blurType: "NORMAL" }, ef) : ef;
        });
      } catch (e2) {
        ctx.warnings.push("effects: " + e2.message);
      }
    }
  }
  if (d.opacity !== undefined && d.opacity !== 1) node.opacity = d.opacity;

  parent.appendChild(node);

  for (var c = 0; c < d.children.length; c++) await buildNode(d.children[c], node, ctx);

  if (d.clipPath) applyClipPath(node, d, ctx);
  if (d.component) {
    if (!ctx.components[d.component]) ctx.components[d.component] = [];
    ctx.components[d.component].push(node);
  }

  applyCommon(node, d, parent, parentAuto, ctx);
  return node;
}

/** CSS clip-path → a mask layer (first child) + the frame's own paint moved into a background layer. */
function applyClipPath(node, d, ctx) {
  safe(ctx, "clip-path", function () {
    var w = node.width, h = node.height;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h + '">' + d.clipPath + "</svg>";
    var auto = node.layoutMode !== "NONE";
    if (node.fills.length || node.strokes.length || node.effects.length) {
      var bg = figma.createRectangle();
      bg.name = "background";
      bg.resize(w, h);
      bg.fills = node.fills;
      bg.strokes = node.strokes;
      if (node.strokes.length) {
        bg.strokeAlign = node.strokeAlign;
        bg.strokeWeight = node.strokeWeight === figma.mixed ? 1 : node.strokeWeight;
      }
      bg.cornerRadius = node.cornerRadius === figma.mixed ? 0 : node.cornerRadius;
      bg.effects = node.effects;
      node.fills = [];
      node.strokes = [];
      node.effects = [];
      node.insertChild(0, bg);
      if (auto) bg.layoutPositioning = "ABSOLUTE";
      bg.x = 0;
      bg.y = 0;
    }
    var m = insertSvgShape(svg, node, 0);
    var mask = m.node;
    mask.name = "clip-path";
    if (auto) mask.layoutPositioning = "ABSOLUTE";
    mask.x = m.x;
    mask.y = m.y;
    mask.isMask = true;
  });
}

var GRID_ALIGN = { MIN: "MIN", CENTER: "CENTER", MAX: "MAX", AUTO: "AUTO" };

/** Position and sizing — must run after the node is inside its parent. */
function applyCommon(node, d, parent, parentAuto, ctx) {
  var inFlow = parentAuto && !d.abs;
  if (parentAuto && d.abs) {
    safe(ctx, "absolute", function () {
      node.layoutPositioning = "ABSOLUTE";
    });
  }
  if (inFlow && d.grid && parent.layoutMode === "GRID") {
    safe(ctx, "grid cell", function () {
      node.setGridChildPosition(d.grid.row, d.grid.col);
      if (d.grid.colSpan > 1) node.gridColumnSpan = d.grid.colSpan;
      if (d.grid.rowSpan > 1) node.gridRowSpan = d.grid.rowSpan;
      if (d.grid.h) node.gridChildHorizontalAlign = GRID_ALIGN[d.grid.h] || "AUTO";
      if (d.grid.v) node.gridChildVerticalAlign = GRID_ALIGN[d.grid.v] || "AUTO";
    });
  }
  if (!inFlow) {
    node.x = d.x || 0;
    node.y = d.y || 0;
  }
  var isAutoFrame = d.kind === "frame" && d.layout && d.layout.mode !== "NONE";
  var sh = d.sizeH || "FIXED";
  var sv = d.sizeV || "FIXED";
  if (!inFlow) {
    if (sh === "FILL") sh = "FIXED";
    if (sv === "FILL") sv = "FIXED";
  }
  // 1) pin fixed axes (auto-layout frames default to HUG, so this must be explicit)
  if (isAutoFrame) {
    safe(ctx, "sizing-fixed", function () {
      if (sh === "FIXED") node.layoutSizingHorizontal = "FIXED";
      if (sv === "FIXED") node.layoutSizingVertical = "FIXED";
      var w = sh === "FIXED" ? Math.max(d.w, 0.01) : node.width;
      var h = sv === "FIXED" ? Math.max(d.h, 0.01) : node.height;
      if (sh === "FIXED" || sv === "FIXED") node.resize(w, h);
    });
  }
  // 2) hug / fill
  safe(ctx, "sizing-h", function () {
    if (sh === "HUG" || sh === "FILL") node.layoutSizingHorizontal = sh;
  });
  safe(ctx, "sizing-v", function () {
    if (sv === "HUG" || sv === "FILL") node.layoutSizingVertical = sv;
  });
  if (d.blend && d.blend !== "NORMAL") {
    safe(ctx, "blend mode", function () {
      node.blendMode = d.blend;
    });
  }
  // 3) CSS transform (rotation / uniform scale / translate) around the element's centre
  if (d.xform && !inFlow) {
    safe(ctx, "transform", function () {
      var X = d.xform;
      if (X.scale && Math.abs(X.scale - 1) > 0.001) node.rescale(X.scale);
      var w = node.width, h = node.height;
      var cx = (d.x || 0) + d.w / 2 + X.dx, cy = (d.y || 0) + d.h / 2 + X.dy;
      var m00 = X.cos, m01 = -X.sin, m10 = X.sin, m11 = X.cos;
      node.relativeTransform = [
        [m00, m01, cx - (m00 * w / 2 + m01 * h / 2)],
        [m10, m11, cy - (m10 * w / 2 + m11 * h / 2)],
      ];
    });
  }
}

// ───────────────────────── post-build passes: components, tokens ─────────────────────────

function sameShape(a, b) {
  if (a.type !== b.type && !(a.type === "COMPONENT" && b.type === "FRAME")) return false;
  var ak = "children" in a ? a.children : [], bk = "children" in b ? b.children : [];
  if (ak.length !== bk.length) return false;
  for (var i = 0; i < ak.length; i++) if (!sameShape(ak[i], bk[i])) return false;
  return true;
}

async function loadNodeFonts(node) {
  var texts = node.type === "TEXT" ? [node] : "findAllWithCriteria" in node ? node.findAllWithCriteria({ types: ["TEXT"] }) : [];
  var seen = {};
  for (var i = 0; i < texts.length; i++) {
    var t = texts[i];
    var fonts = t.characters.length ? t.getRangeAllFontNames(0, t.characters.length) : [t.fontName];
    for (var j = 0; j < fonts.length; j++) {
      var f = fonts[j];
      if (f === figma.mixed) continue;
      var k = f.family + "/" + f.style;
      if (!seen[k]) {
        seen[k] = 1;
        await figma.loadFontAsync(f);
      }
    }
  }
}

async function copyOverrides(inst, orig) {
  if (inst.type === "TEXT" && orig.type === "TEXT") {
    if (inst.characters !== orig.characters) {
      await loadNodeFonts(inst);
      inst.characters = orig.characters;
    }
    if (JSON.stringify(inst.fills) !== JSON.stringify(orig.fills) && orig.fills !== figma.mixed) inst.fills = orig.fills;
    return;
  }
  if ("fills" in inst && orig.fills !== figma.mixed && JSON.stringify(inst.fills) !== JSON.stringify(orig.fills)) inst.fills = orig.fills;
  if ("visible" in inst && inst.visible !== orig.visible) inst.visible = orig.visible;
  var a = "children" in inst ? inst.children : [], b = "children" in orig ? orig.children : [];
  for (var i = 0; i < a.length; i++) await copyOverrides(a[i], b[i]);
}

/** Elements marked data-figma-component="Name": first becomes the main component, the rest become instances with overrides. */
async function makeComponents(ctx) {
  var made = [];
  for (var name in ctx.components) {
    var list = ctx.components[name];
    if (!list.length) continue;
    var main = figma.createComponentFromNode(list[0]);
    main.name = name;
    var instances = 0;
    for (var k = 1; k < list.length; k++) {
      var orig = list[k];
      if (!sameShape(main, orig)) {
        ctx.warnings.push("component '" + name + "': element #" + (k + 1) + " has a different structure, kept as a frame");
        continue;
      }
      var par = orig.parent;
      var idx = par.children.indexOf(orig);
      var props = {
        x: orig.x, y: orig.y, abs: "layoutPositioning" in orig ? orig.layoutPositioning : null,
        sh: orig.layoutSizingHorizontal, sv: orig.layoutSizingVertical, w: orig.width, h: orig.height,
        grid: par.layoutMode === "GRID" ? [orig.gridRowAnchorIndex, orig.gridColumnAnchorIndex, orig.gridRowSpan, orig.gridColumnSpan] : null,
      };
      var inst = main.createInstance();
      figma.currentPage.appendChild(inst);
      await copyOverrides(inst, orig); // before removal: removed nodes are no longer readable
      orig.remove();
      par.insertChild(Math.min(idx, par.children.length), inst);
      var auto = par.type !== "PAGE" && "layoutMode" in par && par.layoutMode !== "NONE";
      try {
        if (auto && props.abs === "ABSOLUTE") inst.layoutPositioning = "ABSOLUTE";
        if (props.grid) {
          inst.setGridChildPosition(props.grid[0], props.grid[1]);
          if (props.grid[2] > 1) inst.gridRowSpan = props.grid[2];
          if (props.grid[3] > 1) inst.gridColumnSpan = props.grid[3];
        }
        if (!auto || props.abs === "ABSOLUTE") {
          inst.x = props.x;
          inst.y = props.y;
        }
        if (props.sh === "FIXED" || props.sv === "FIXED") inst.resize(props.w, props.h);
        if (auto) {
          inst.layoutSizingHorizontal = props.sh;
          inst.layoutSizingVertical = props.sv;
        }
      } catch (e) {
        ctx.warnings.push("component '" + name + "' instance placement: " + e.message);
      }
      instances++;
    }
    made.push({ name: name, componentId: main.id, instances: instances });
  }
  return made;
}

function colorKey(c, a) {
  return hex(c) + "/" + Math.round((a === undefined ? 1 : a) * 100);
}

async function resolveVarValue(v, modeId, depth) {
  var val = v.valuesByMode[modeId];
  if (val === undefined) val = v.valuesByMode[Object.keys(v.valuesByMode)[0]];
  if (val && val.type === "VARIABLE_ALIAS" && (depth || 0) < 6) {
    var t = await figma.variables.getVariableByIdAsync(val.id);
    if (!t) return null;
    var col = await figma.variables.getVariableCollectionByIdAsync(t.variableCollectionId);
    return resolveVarValue(t, col.defaultModeId, (depth || 0) + 1);
  }
  return val;
}

var FLOAT_FIELDS = [
  ["itemSpacing", "GAP"], ["counterAxisSpacing", "GAP"], ["paddingTop", "GAP"], ["paddingRight", "GAP"], ["paddingBottom", "GAP"], ["paddingLeft", "GAP"],
  ["gridRowGap", "GAP"], ["gridColumnGap", "GAP"],
  ["topLeftRadius", "CORNER_RADIUS"], ["topRightRadius", "CORNER_RADIUS"], ["bottomLeftRadius", "CORNER_RADIUS"], ["bottomRightRadius", "CORNER_RADIUS"],
  ["strokeWeight", "STROKE_FLOAT"],
];

/** Bind raw values in a subtree to matching local variables (colors, spacing, radii, font sizes) and text styles. */
async function bindTokens(root) {
  var cols = await figma.variables.getLocalVariableCollectionsAsync();
  var colors = {}, floats = {};
  for (var i = 0; i < cols.length; i++) {
    for (var j = 0; j < cols[i].variableIds.length; j++) {
      var v = await figma.variables.getVariableByIdAsync(cols[i].variableIds[j]);
      if (!v) continue;
      var val = await resolveVarValue(v, cols[i].defaultModeId);
      if (val === null || val === undefined) continue;
      if (v.resolvedType === "COLOR") {
        var k = colorKey(val, val.a);
        if (!colors[k]) colors[k] = v;
      } else if (v.resolvedType === "FLOAT" && typeof val === "number" && val !== 0) {
        (floats[val] = floats[val] || []).push(v);
      }
    }
  }
  var textStyles = await figma.getLocalTextStylesAsync();
  var stats = { colors: 0, numbers: 0, textStyles: 0 };
  function pickFloat(value, scope) {
    var list = floats[Math.round(value * 100) / 100];
    if (!list) return null;
    for (var q = 0; q < list.length; q++) {
      var sc = list[q].scopes || [];
      if (sc.indexOf("ALL_SCOPES") >= 0 || sc.indexOf(scope) >= 0) return list[q];
    }
    return null;
  }
  function bindPaints(paints) {
    if (paints === figma.mixed || !paints.length) return null;
    var changed = false;
    var out = paints.map(function (p) {
      if (p.type !== "SOLID" || (p.boundVariables && p.boundVariables.color)) return p;
      var cv = colors[colorKey(p.color, p.opacity)] || colors[colorKey(p.color, 1)];
      if (!cv) return p;
      changed = true;
      stats.colors++;
      return figma.variables.setBoundVariableForPaint(p, "color", cv);
    });
    return changed ? out : null;
  }
  var nodes = [root].concat("findAll" in root ? root.findAll(function () { return true; }) : []);
  for (var n = 0; n < nodes.length; n++) {
    var node = nodes[n];
    try {
      if ("fills" in node) { var f = bindPaints(node.fills); if (f) node.fills = f; }
      if ("strokes" in node) { var s = bindPaints(node.strokes); if (s) node.strokes = s; }
      FLOAT_FIELDS.forEach(function (pair) {
        if (!(pair[0] in node)) return;
        var cur = node[pair[0]];
        if (typeof cur !== "number" || cur === 0) return;
        if (pair[0] === "strokeWeight" && (!("strokes" in node) || !node.strokes.length)) return;
        if (pair[0].indexOf("padding") === 0 || pair[0].indexOf("Spacing") >= 0) { if (node.layoutMode === "NONE") return; }
        var fv = pickFloat(cur, pair[1]);
        if (fv) { node.setBoundVariable(pair[0], fv); stats.numbers++; }
      });
      if (node.type === "TEXT" && node.fontName !== figma.mixed && node.fontSize !== figma.mixed) {
        var st = textStyles.find(function (ts) {
          return ts.fontName.family === node.fontName.family && ts.fontName.style === node.fontName.style && ts.fontSize === node.fontSize;
        });
        if (st) { await node.setTextStyleIdAsync(st.id); stats.textStyles++; }
        else {
          var fsv = pickFloat(node.fontSize, "FONT_SIZE");
          if (fsv) { node.setBoundVariable("fontSize", fsv); stats.numbers++; }
        }
      }
    } catch (e) { /* binding is best-effort */ }
  }
  return stats;
}

async function buildTree(p) {
  var ctx = new Ctx();
  ctx.warnings = (p.warnings || []).slice();
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  await collectFonts(p.tree, ctx.warnings);
  var root = await buildNode(p.tree, figma.currentPage, ctx); // build on page first, then move
  var target = await place(root, p.parentId, p.x, p.y);
  if (p.name) root.name = p.name;
  var res = {
    rootId: root.id,
    name: root.name,
    size: { w: Math.round(root.width), h: Math.round(root.height) },
    nodes: ctx.count,
    parent: target.id,
  };
  if (Object.keys(ctx.components).length) {
    res.components = await makeComponents(ctx);
    root = await figma.getNodeByIdAsync(res.rootId) || root;
  }
  if (p.bindVariables) res.tokens = await bindTokens(root);
  res.warnings = ctx.warnings;
  figma.currentPage.selection = [root];
  figma.viewport.scrollAndZoomIntoView([root]);
  if (p.screenshot !== false) res.images = [await exportNode(root, 1)];
  return res;
}

// ───────────────────────── read ─────────────────────────

function dumpNode(n, depth) {
  var o = { id: n.id, name: n.name, type: n.type };
  if ("visible" in n && !n.visible) o.visible = false;
  if ("x" in n && n.type !== "PAGE") {
    o.x = round(n.x);
    o.y = round(n.y);
    o.w = round(n.width);
    o.h = round(n.height);
  }
  if ("rotation" in n && n.rotation) o.rotation = round(n.rotation);
  if ("opacity" in n && n.opacity !== 1) o.opacity = round(n.opacity);
  if ("blendMode" in n && n.blendMode !== "PASS_THROUGH" && n.blendMode !== "NORMAL") o.blendMode = n.blendMode;
  if ("isMask" in n && n.isMask) o.isMask = true;
  if ("layoutMode" in n && n.layoutMode === "GRID") {
    o.layout = {
      mode: "GRID", rows: n.gridRowCount, cols: n.gridColumnCount, rowGap: n.gridRowGap, colGap: n.gridColumnGap,
      pad: [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft],
    };
    try { o.layout.css = n.gridColumnSizingCSS.trim(); } catch (e) {}
  } else if ("layoutMode" in n && n.layoutMode !== "NONE") {
    o.layout = {
      mode: n.layoutMode,
      gap: n.itemSpacing,
      pad: [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft],
      primary: n.primaryAxisAlignItems,
      counter: n.counterAxisAlignItems,
    };
    if (n.layoutWrap === "WRAP") o.layout.wrap = true;
  }
  try {
    if (n.parent && n.parent.layoutMode === "GRID") o.cell = [n.gridRowAnchorIndex, n.gridColumnAnchorIndex, n.gridRowSpan, n.gridColumnSpan];
  } catch (e) {}
  try {
    if ("layoutSizingHorizontal" in n) o.sizing = [n.layoutSizingHorizontal, n.layoutSizingVertical];
  } catch (e) {}
  if ("layoutPositioning" in n && n.layoutPositioning === "ABSOLUTE") o.absolute = true;
  if ("fills" in n && n.fills !== figma.mixed && n.fills.length) o.fills = n.fills.map(simplifyPaint);
  if ("strokes" in n && n.strokes.length) {
    o.strokes = n.strokes.map(simplifyPaint);
    o.strokeWeight = n.strokeWeight === figma.mixed ? "<mixed>" : n.strokeWeight;
  }
  if ("cornerRadius" in n && n.cornerRadius) o.radius = n.cornerRadius === figma.mixed ? "<mixed>" : n.cornerRadius;
  if ("effects" in n && n.effects.length) o.effects = n.effects.map(simplifyEffect);
  if ("clipsContent" in n && n.clipsContent) o.clip = true;
  if (n.type === "TEXT") {
    o.text = n.characters.length > 300 ? n.characters.slice(0, 300) + "…" : n.characters;
    o.font = n.fontName === figma.mixed ? "<mixed>" : n.fontName.family + " " + n.fontName.style;
    o.fontSize = n.fontSize === figma.mixed ? "<mixed>" : n.fontSize;
    o.textAutoResize = n.textAutoResize;
    if (n.textTruncation === "ENDING") o.maxLines = n.maxLines;
  }
  if ("reactions" in n && n.reactions && n.reactions.length) o.interactions = n.reactions.map(function (r) { return summarizeReaction(n, r); });
  try {
    var tracks = n.manualKeyframeTracks ? Object.keys(n.manualKeyframeTracks) : [];
    var styles = n.animationStyles || [];
    if (tracks.length || styles.length) o.motion = { tracks: tracks, styles: styles.map(function (s) { return s.name.replace("motion.preset_name.", ""); }) };
  } catch (e) {}
  if (n.type === "INSTANCE" && n.mainComponent) o.component = n.mainComponent.name;
  if ("boundVariables" in n && n.boundVariables && Object.keys(n.boundVariables).length) o.boundVariables = Object.keys(n.boundVariables);
  if ("children" in n) {
    if (depth > 0) o.children = n.children.map(function (c) { return dumpNode(c, depth - 1); });
    else o.childCount = n.children.length;
  }
  return o;
}

async function readFile() {
  var out = { file: figma.root.name, pages: figma.root.children.map(function (p) { return { id: p.id, name: p.name }; }), currentPage: figma.currentPage.name };
  try {
    var cols = await figma.variables.getLocalVariableCollectionsAsync();
    out.variableCollections = [];
    for (var i = 0; i < cols.length; i++) {
      var col = cols[i];
      var vars = [];
      for (var j = 0; j < Math.min(col.variableIds.length, 300); j++) {
        var v = await figma.variables.getVariableByIdAsync(col.variableIds[j]);
        if (v) vars.push({ id: v.id, name: v.name, type: v.resolvedType, scopes: v.scopes, values: ser(v.valuesByMode, 3) });
      }
      out.variableCollections.push({ id: col.id, name: col.name, modes: col.modes, variables: vars });
    }
  } catch (e) {
    out.variableCollections = "unavailable: " + e.message;
  }
  try {
    out.paintStyles = (await figma.getLocalPaintStylesAsync()).map(function (s) { return { id: s.id, name: s.name, paints: s.paints.map(simplifyPaint) }; });
    out.textStyles = (await figma.getLocalTextStylesAsync()).map(function (s) { return { id: s.id, name: s.name, font: s.fontName.family + " " + s.fontName.style, size: s.fontSize }; });
    out.effectStyles = (await figma.getLocalEffectStylesAsync()).map(function (s) { return { id: s.id, name: s.name, effects: s.effects.map(simplifyEffect) }; });
    out.gridStyles = (await figma.getLocalGridStylesAsync()).map(function (s) { return { id: s.id, name: s.name }; });
  } catch (e) {
    out.styles = "unavailable: " + e.message;
  }
  try {
    out.animationStyles = (await figma.getLocalCustomAnimationStylesAsync()).map(function (s) { return { id: s.id, name: s.name }; });
  } catch (e) {}
  try {
    out.componentsOnCurrentPage = figma.currentPage
      .findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] })
      .slice(0, 200)
      .map(function (c) { return { id: c.id, name: c.name, type: c.type, key: c.key }; });
  } catch (e) {}
  return out;
}

async function doRead(p) {
  var depth = p.depth === undefined ? 3 : p.depth;
  var t = p.target || "selection";
  if (t === "file") return readFile();
  if (t === "page") return dumpNode(figma.currentPage, depth);
  if (t === "selection") {
    var sel = figma.currentPage.selection;
    if (!sel.length) return { selection: [], hint: "Nothing selected. Use target:'page' or a node id." };
    return sel.map(function (n) { return dumpNode(n, depth); });
  }
  return dumpNode(await getNode(t), depth);
}

// ───────────────────────── execute ─────────────────────────


// ───────────────────────── effects: transform, isometric, glow ─────────────────────────

/** Compose two 2×3 affine matrices: apply B first, then A. */
function mulAffine(A, B) {
  return [
    [A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1], A[0][0] * B[0][2] + A[0][1] * B[1][2] + A[0][2]],
    [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1], A[1][0] * B[0][2] + A[1][1] * B[1][2] + A[1][2]],
  ];
}

/**
 * Apply a linear map m = [a, b, c, d] (x' = a·x + c·y, y' = b·x + d·y) to a node around its centre.
 * Figma keeps skew in relativeTransform, so this stays a live, editable layer.
 */
function transformAround(node, m) {
  var T0 = node.relativeTransform, w = node.width, h = node.height;
  var cx = T0[0][0] * w / 2 + T0[0][1] * h / 2 + T0[0][2], cy = T0[1][0] * w / 2 + T0[1][1] * h / 2 + T0[1][2];
  var M = [[m[0], m[2], 0], [m[1], m[3], 0]];
  var toC = [[1, 0, cx], [0, 1, cy]], fromC = [[1, 0, -cx], [0, 1, -cy]];
  var D = mulAffine(toC, mulAffine(M, mulAffine(fromC, T0)));
  node.relativeTransform = D;
  // Figma stores skew with unit-length axis columns, so the edge lengths of the skewed side shrink back
  // (a 0.4 rad x-skew would come out 8% too short vertically). Restore them through the node size.
  var A = node.relativeTransform;
  var len = function (T, i) { return Math.sqrt(T[0][i] * T[0][i] + T[1][i] * T[1][i]); };
  var sx = len(D, 0) / (len(A, 0) || 1), sy = len(D, 1) / (len(A, 1) || 1);
  if (Math.abs(sx - 1) > 1e-3 || Math.abs(sy - 1) > 1e-3) {
    node.resize(Math.max(0.01, w * sx), Math.max(0.01, h * sy));
    var B = node.relativeTransform, w2 = node.width, h2 = node.height;
    var cx2 = B[0][0] * w2 / 2 + B[0][1] * h2 / 2 + B[0][2], cy2 = B[1][0] * w2 / 2 + B[1][1] * h2 / 2 + B[1][2];
    var tx = cx - cx2, ty = cy - cy2;
    node.relativeTransform = [[B[0][0], B[0][1], B[0][2] + tx], [B[1][0], B[1][1], B[1][2] + ty]];
  }
  return node;
}

// Isometric projection of a flat layer onto a face of a cube (axes at ±30°, lengths preserved).
var ISO_FACES = {
  top: [0.8660254, 0.5, -0.8660254, 0.5],
  left: [0.8660254, 0.5, 0, 1],
  right: [0.8660254, -0.5, 0, 1],
};

function isoTransform(node, face, o) {
  o = o || {};
  var m = ISO_FACES[face];
  if (!m) throw new Error("h.iso face must be top | left | right, got '" + face + "'");
  var s = o.scale === undefined ? 1 : o.scale;
  return transformAround(node, [m[0] * s, m[1] * s, m[2] * s, m[3] * s]);
}

// ── true perspective ──

/** Projective map from the unit square to the quad q = [TL, TR, BR, BL] (Heckbert). Returns f(u, v) → [x, y]. */
function quadMap(q) {
  var x0 = q[0][0], y0 = q[0][1], x1 = q[1][0], y1 = q[1][1], x2 = q[2][0], y2 = q[2][1], x3 = q[3][0], y3 = q[3][1];
  var sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3, g = 0, hh = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    var dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) < 1e-12) throw new Error("h.perspective: the target quad is degenerate (collinear corners)");
    g = (sx * dy2 - dx2 * sy) / den;
    hh = (dx1 * sy - sx * dy1) / den;
  }
  var a = x1 - x0 + g * x1, b = x3 - x0 + hh * x3, d = y1 - y0 + g * y1, e = y3 - y0 + hh * y3;
  return function (u, v) {
    var w = g * u + hh * v + 1;
    return [(a * u + b * v + x0) / w, (d * u + e * v + y0) / w];
  };
}

/** Parent-space bounding box of a node (honours rotation), used as the source rectangle of the warp. */
function parentBox(node) {
  var T = node.relativeTransform, w = node.width, h = node.height, xs = [], ys = [];
  [[0, 0], [w, 0], [w, h], [0, h]].forEach(function (p) {
    xs.push(T[0][0] * p[0] + T[0][1] * p[1] + T[0][2]);
    ys.push(T[1][0] * p[0] + T[1][1] * p[1] + T[1][2]);
  });
  var x = Math.min.apply(null, xs), y = Math.min.apply(null, ys);
  return { x: x, y: y, w: Math.max.apply(null, xs) - x, h: Math.max.apply(null, ys) - y };
}

/** Target quad from opts.quad (4 points, parent space) or opts.shrink ('top'|'bottom'|'left'|'right') + opts.amount (0–0.95) + opts.skew. */
function perspectiveQuad(box, o) {
  var q = o.quad || o.corners;
  if (q) {
    if (!Array.isArray(q) || q.length !== 4) throw new Error("h.perspective: quad must be 4 points [TL, TR, BR, BL]");
    return q.map(function (p) { return Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y]; });
  }
  var x = box.x, y = box.y, w = box.w, h = box.h;
  var amt = Math.max(0, Math.min(0.95, o.amount === undefined ? 0.3 : o.amount));
  var side = o.shrink || "top";
  var q2 = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  var dx = (w * amt) / 2, dy = (h * amt) / 2;
  if (side === "top") { q2[0][0] += dx; q2[1][0] -= dx; }
  else if (side === "bottom") { q2[3][0] += dx; q2[2][0] -= dx; }
  else if (side === "left") { q2[0][1] += dy; q2[3][1] -= dy; }
  else if (side === "right") { q2[1][1] += dy; q2[2][1] -= dy; }
  else throw new Error("h.perspective: shrink must be top | bottom | left | right");
  if (o.skew) q2.forEach(function (p) { p[0] += o.skew * (p[1] - (y + h / 2)); });
  return q2;
}

var PERSPECTIVE_VECTOR_TYPES = { VECTOR: 1, RECTANGLE: 1, ELLIPSE: 1, POLYGON: 1, STAR: 1, LINE: 1, BOOLEAN_OPERATION: 1, TEXT: 1 };

/** Warp the geometry of a vector-like node through f: bezier segments are cut into `cuts` pieces and each point and tangent is mapped. */
function perspectiveVector(node, f, box, cuts) {
  var holder = node.clone();
  node.parent.insertChild(node.parent.children.indexOf(node) + 1, holder);
  var v = holder.type === "VECTOR" ? holder : figma.flatten([holder], node.parent);
  var T = v.relativeTransform, net = v.vectorNetwork;
  function toUV(p) {
    var X = T[0][0] * p[0] + T[0][1] * p[1] + T[0][2], Y = T[1][0] * p[0] + T[1][1] * p[1] + T[1][2];
    return [(X - box.x) / (box.w || 1), (Y - box.y) / (box.h || 1)];
  }
  function map(p) { var uv = toUV(p); return f(uv[0], uv[1]); }
  // mapped tangent: the image of a short local offset
  function mapT(p, d) { var a = map(p), b = map([p[0] + d[0], p[1] + d[1]]); return [b[0] - a[0], b[1] - a[1]]; }
  var verts = net.vertices.map(function (p) { return { x: p.x, y: p.y }; });
  var out = net.vertices.map(function (p) {
    var m = map([p.x, p.y]), o = { x: m[0], y: m[1] };
    ["strokeCap", "strokeJoin", "strokeMiterLimit", "cornerRadius", "handleMirroring"].forEach(function (k) { if (p[k] !== undefined) o[k] = p[k]; });
    return o;
  });
  var segMap = [], newSegs = [];
  net.segments.forEach(function (s, i) {
    var a = verts[s.start], b = verts[s.end], ta = s.tangentStart || { x: 0, y: 0 }, tb = s.tangentEnd || { x: 0, y: 0 };
    var straight = !ta.x && !ta.y && !tb.x && !tb.y;
    var n = straight ? 1 : cuts, P = [[a.x, a.y], [a.x + ta.x, a.y + ta.y], [b.x + tb.x, b.y + tb.y], [b.x, b.y]];
    function pt(t) {
      var u = 1 - t;
      return [0, 1].map(function (k) { return u * u * u * P[0][k] + 3 * u * u * t * P[1][k] + 3 * u * t * t * P[2][k] + t * t * t * P[3][k]; });
    }
    function der(t) {
      var u = 1 - t;
      return [0, 1].map(function (k) { return 3 * u * u * (P[1][k] - P[0][k]) + 6 * u * t * (P[2][k] - P[1][k]) + 3 * t * t * (P[3][k] - P[2][k]); });
    }
    var ids = [], prev = s.start;
    for (var k = 1; k <= n; k++) {
      var t0 = (k - 1) / n, t1 = k / n, dt = (t1 - t0) / 3, next;
      if (k === n) next = s.end;
      else { var m = map(pt(t1)); out.push({ x: m[0], y: m[1] }); next = out.length - 1; }
      var d0 = der(t0), d1 = der(t1), seg = { start: prev, end: next };
      if (!straight) {
        var p0 = pt(t0), p1 = pt(t1), m0 = mapT(p0, [d0[0] * dt, d0[1] * dt]), m1 = mapT(p1, [-d1[0] * dt, -d1[1] * dt]);
        seg.tangentStart = { x: m0[0], y: m0[1] };
        seg.tangentEnd = { x: m1[0], y: m1[1] };
      }
      newSegs.push(seg);
      ids.push(newSegs.length - 1);
      prev = next;
    }
    segMap.push(ids);
  });
  var regions = (net.regions || []).map(function (r) {
    var loops = r.loops.map(function (loop) {
      var res = [], cur = null;
      loop.forEach(function (si, idx) {
        var s = net.segments[si], fwd = true;
        if (cur === null) {
          if (loop.length > 1) { var nx = net.segments[loop[1]]; fwd = s.end === nx.start || s.end === nx.end; }
        } else fwd = s.start === cur;
        var ids = segMap[si].slice();
        if (!fwd) ids.reverse();
        res = res.concat(ids);
        cur = fwd ? s.end : s.start;
      });
      return res;
    });
    var o = { loops: loops, windingRule: r.windingRule };
    if (r.fills) o.fills = r.fills;
    if (r.fillStyleId) o.fillStyleId = r.fillStyleId;
    return o;
  });
  // flipped sub-segments of a reversed loop must keep their own direction; Figma reads loops by connectivity.
  var minX = Infinity, minY = Infinity;
  out.forEach(function (p) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); });
  out.forEach(function (p) { p.x -= minX; p.y -= minY; });
  v.relativeTransform = [[1, 0, minX], [0, 1, minY]];
  v.vectorNetwork = { vertices: out, segments: newSegs, regions: regions };
  v.name = node.name + " · perspective";
  return v;
}

/** Warp any node through the map f by cutting it into a grid of image tiles, each an affine patch. */
async function perspectiveRaster(node, f, box, o) {
  var gx = Math.max(1, Math.min(64, Math.round(o.grid || 16))), gy = Math.max(1, Math.min(64, Math.round(o.gridY || o.grid || 16)));
  var scale = o.scale || 2;
  var bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
  var img = figma.createImage(bytes);
  var size = await img.getSizeAsync();
  var w = box.w, h = box.h, cw = w / gx, ch = h / gy, ov = Math.min(cw, ch) * 0.04 + 0.4;
  var tiles = [];
  for (var j = 0; j < gy; j++) {
    for (var i = 0; i < gx; i++) {
      // source cell, widened a hair on the far sides so neighbouring tiles overlap and leave no seam
      var sx0 = i * cw, sy0 = j * ch, sx1 = Math.min(w, (i + 1) * cw + (i < gx - 1 ? ov : 0)), sy1 = Math.min(h, (j + 1) * ch + (j < gy - 1 ? ov : 0));
      var tw = sx1 - sx0, th = sy1 - sy0;
      var p0 = f(sx0 / w, sy0 / h), p1 = f(sx1 / w, sy0 / h), p3 = f(sx0 / w, sy1 / h);
      var r = figma.createRectangle();
      node.parent.appendChild(r); // tile coordinates are in the parent's space
      r.resize(Math.max(0.01, tw), Math.max(0.01, th));
      var D = [
        [(p1[0] - p0[0]) / tw, (p3[0] - p0[0]) / th, p0[0]],
        [(p1[1] - p0[1]) / tw, (p3[1] - p0[1]) / th, p0[1]],
      ];
      r.relativeTransform = D;
      // Figma keeps unit-length axes for a skewed node, so restore the edge lengths through the size (as in transformAround);
      // resize keeps the top-left corner fixed
      var A = r.relativeTransform;
      var len = function (T, k) { return Math.sqrt(T[0][k] * T[0][k] + T[1][k] * T[1][k]); };
      var fx = len(D, 0) / (len(A, 0) || 1), fy = len(D, 1) / (len(A, 1) || 1);
      if (Math.abs(fx - 1) > 1e-3 || Math.abs(fy - 1) > 1e-3) r.resize(Math.max(0.01, tw * fx), Math.max(0.01, th * fy));
      r.fills = [{
        type: "IMAGE", imageHash: img.hash, scaleMode: "CROP",
        imageTransform: [[tw / w, 0, sx0 / w], [0, th / h, sy0 / h]],
      }];
      r.name = "tile " + i + "," + j;
      tiles.push(r);
    }
  }
  var g = figma.group(tiles, node.parent);
  g.name = node.name + " · perspective";
  return g;
}

/**
 * True perspective: h.perspective(node, {shrink:'top', amount:0.35}) or {quad:[TL,TR,BR,BL]} (parent coordinates).
 * Vector-like nodes become a warped vector (live, crisp); frames, groups, images and anything else become an
 * image-tile mesh ({grid}). The original is hidden unless {keep:true}. Returns the new node.
 */
async function perspectiveTransform(node, o) {
  o = o || {};
  if (!node || !node.parent) throw new Error("h.perspective: pass a node that lives on the canvas");
  var box = parentBox(node), f = quadMap(perspectiveQuad(box, o));
  var mode = o.mode || (PERSPECTIVE_VECTOR_TYPES[node.type] ? "vector" : "raster");
  var res = mode === "vector" ? perspectiveVector(node, f, box, Math.max(2, Math.min(32, Math.round(o.cuts || 10)))) : await perspectiveRaster(node, f, box, o);
  if (o.keep !== true) node.visible = false;
  return res;
}

// ── grain, progressive blur, halftone ──

function clampNum(v, def, lo, hi) { v = typeof v === "number" && isFinite(v) ? v : def; return Math.max(lo, Math.min(hi, v)); }

/** Put a new node right above `node` in its parent (absolute inside auto-layout frames). */
function placeAbove(node, nn) {
  var par = node.parent;
  par.insertChild(par.children.indexOf(node) + 1, nn);
  if (par.layoutMode && par.layoutMode !== "NONE") { try { nn.layoutPositioning = "ABSOLUTE"; } catch (err) { /* older files */ } }
  return nn;
}

/** Native Figma NOISE effect (live and editable in the Effects panel). */
function noiseEffect(o) {
  var a = clampNum(o.amount, 0.35, 0, 1), eff = {
    type: "NOISE", visible: true, noiseSize: clampNum(o.size, 1, 0.1, 16), density: clampNum(o.density, 0.6, 0, 1),
  };
  var c1 = hexToRgba(o.color || "#000000");
  if ((o.tone || "duo") === "mono") {
    eff.noiseType = "MONOTONE";
    eff.color = { r: c1.r, g: c1.g, b: c1.b, a: a };
  } else {
    var c2 = hexToRgba(o.color2 || "#ffffff");
    eff.noiseType = "DUOTONE";
    eff.color = { r: c1.r, g: c1.g, b: c1.b, a: a };
    eff.secondaryColor = { r: c2.r, g: c2.g, b: c2.b, a: a };
  }
  return eff;
}

/**
 * Film grain / noise using Figma's native NOISE effect. Frames, rectangles and groups get a full-size overlay layer
 * ("Grain", neutral grey blended with OVERLAY so only the grain shows); other shapes get the effect directly.
 * o: amount 0–1 (alpha, default .35) · size (grain px, default 1) · density 0–1 (default .6) · tone 'duo' (dark+light, default) | 'mono'
 *    color / color2 (hex; mono uses color) · blend OVERLAY | SOFT_LIGHT | HARD_LIGHT · mode 'overlay' | 'direct' (default by node type)
 */
function makeGrain(node, o) {
  o = o || {};
  var eff = noiseEffect(o);
  var mode = o.mode || ({ FRAME: 1, COMPONENT: 1, INSTANCE: 1, RECTANGLE: 1, GROUP: 1 }[node.type] ? "overlay" : "direct");
  if (mode === "direct") {
    if (!("effects" in node)) throw new Error("h.grain: this node cannot take effects; use mode 'overlay'");
    node.effects = node.effects.concat([eff]);
    return node;
  }
  var blend = ["OVERLAY", "SOFT_LIGHT", "HARD_LIGHT"].indexOf(o.blend) >= 0 ? o.blend : "OVERLAY";
  var r = figma.createRectangle();
  r.name = "Grain";
  r.fills = [{ type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.5 } }];
  r.blendMode = blend;
  r.effects = [eff];
  r.locked = o.lock === true;
  if (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") {
    node.appendChild(r);
    if (node.layoutMode && node.layoutMode !== "NONE") { try { r.layoutPositioning = "ABSOLUTE"; } catch (err) { /* older files */ } }
    r.resize(node.width, node.height);
    r.x = 0; r.y = 0;
    r.constraints = { horizontal: "STRETCH", vertical: "STRETCH" };
    if (typeof node.cornerRadius === "number") r.cornerRadius = node.cornerRadius;
  } else {
    placeAbove(node, r);
    var b = parentBox(node);
    r.resize(Math.max(0.01, b.w), Math.max(0.01, b.h));
    r.x = b.x; r.y = b.y;
    if (typeof node.cornerRadius === "number") r.cornerRadius = node.cornerRadius;
  }
  return r;
}

/**
 * Progressive blur (native: blur strength ramps along an axis). h.progressiveBlur(node, {side:'bottom', radius:24})
 * o: side — where the blur is strongest: 'top' | 'bottom' (default) | 'left' | 'right' · radius (px, default 24) · startRadius (default 0)
 *    from / to — where the ramp begins and ends along the axis, 0–1 of the node (default 0 and 1) · background:true blurs what is behind
 *    (frosted header fading out) instead of the layer itself · replace:true drops existing blurs first
 */
function makeProgressiveBlur(node, o) {
  o = o || {};
  if (!("effects" in node)) throw new Error("h.progressiveBlur: this node cannot take effects");
  var side = o.side || "bottom", from = clampNum(o.from, 0, 0, 1), to = clampNum(o.to, 1, 0, 1);
  var ax = { top: [0, 1], bottom: [0, 0], left: [1, 1], right: [1, 0] }[side];
  if (!ax) throw new Error("h.progressiveBlur: side must be top | bottom | left | right");
  // the ramp starts at `from` (weak end) and ends at `to` (strong end); for top/left the strong end is at 0
  var p0 = ax[1] ? 1 - from : from, p1 = ax[1] ? 1 - to : to;
  var s = ax[0] ? { x: p0, y: 0.5 } : { x: 0.5, y: p0 }, e = ax[0] ? { x: p1, y: 0.5 } : { x: 0.5, y: p1 };
  var eff = {
    type: o.background ? "BACKGROUND_BLUR" : "LAYER_BLUR", blurType: "PROGRESSIVE", visible: true,
    radius: clampNum(o.radius, 24, 0, 250), startRadius: clampNum(o.startRadius, 0, 0, 250), startOffset: s, endOffset: e,
  };
  var keep = o.replace ? node.effects.filter(function (x) { return x.type !== "LAYER_BLUR" && x.type !== "BACKGROUND_BLUR"; }) : node.effects;
  node.effects = keep.concat([eff]);
  return node;
}

var SAMPLE_WAITERS = {}, SAMPLE_SEQ = 1;

/** Decode PNG bytes in the plugin UI (it has a canvas) and get back RGBA pixels, downscaled to maxSide. */
function sampleViaUI(bytes, maxSide) {
  return new Promise(function (resolve, reject) {
    var id = SAMPLE_SEQ++;
    var t = setTimeout(function () { delete SAMPLE_WAITERS[id]; reject(new Error("pixel sampling timed out; keep the plugin window open")); }, 30000);
    SAMPLE_WAITERS[id] = { resolve: resolve, reject: reject, t: t };
    figma.ui.postMessage({ type: "sample", id: id, bytes: bytes, maxSide: maxSide });
  });
}

/**
 * Halftone of a layer, built as ONE vector of dots / squares / lines on a rotated grid.
 * h.halftone(node, {cell: 8, shape: 'dot', color: '#111'})
 * o: cell (grid pitch px, default 8) · shape 'dot' | 'square' | 'diamond' | 'line' (default dot) · angle (grid rotation °, default 45; 0 for lines)
 *    color (ink hex, default #000000; 'source' = one ellipse per dot in the layer's own colours, max ~3000 dots)
 *    invert (false: dark areas get big dots, for ink on light; true: light areas get big dots, for light dots on dark)
 *    gamma (default 1; <1 grows dots) · contrast (default 1) · max (largest dot as a share of the cell, default 1.05)
 *    bg (hex: adds a background rectangle) · keep (true keeps the original visible)
 * Returns the vector (or the group when bg is set / color is 'source').
 */
async function makeHalftone(node, o) {
  o = o || {};
  if (!node || !node.parent || !("exportAsync" in node)) throw new Error("h.halftone: pass a node that lives on the canvas");
  var shape = o.shape || "dot";
  if (["dot", "square", "diamond", "line"].indexOf(shape) < 0) throw new Error("h.halftone: shape must be dot | square | diamond | line");
  var box = parentBox(node), colored = o.color === "source";
  var cell = clampNum(o.cell, 8, 1.5, 400);
  cell = Math.max(cell, Math.sqrt((box.w * box.h) / (colored ? 3000 : 12000)));
  var angle = clampNum(o.angle, shape === "line" ? 0 : 45, -360, 360) * Math.PI / 180, ca = Math.cos(angle), sa = Math.sin(angle);
  var gamma = clampNum(o.gamma, 1, 0.1, 5), contrast = clampNum(o.contrast, 1, 0.1, 5), maxS = clampNum(o.max, 1.05, 0.1, 3), invert = !!o.invert;

  // sample the layer: about three pixels per cell, at most 1024 px on the long side
  var side = Math.min(1024, Math.max(32, Math.ceil(Math.max(box.w, box.h) / (cell / 3))));
  var scale = side / Math.max(node.width, node.height, 1);
  var bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: Math.min(scale, 4) } });
  var px = await sampleViaUI(bytes, side);
  var data = px.data, iw = px.w, ih = px.h;
  function at(u, v, k) {
    var x = Math.max(0, Math.min(iw - 1, Math.floor(u * iw))), y = Math.max(0, Math.min(ih - 1, Math.floor(v * ih)));
    return data[(y * iw + x) * 4 + k];
  }
  function sample(u, v) { // 3×3 mean (alpha-weighted colour) around the point
    var du = 1 / iw, dv = 1 / ih, r = 0, g = 0, b = 0, a = 0;
    for (var j = -1; j <= 1; j++) for (var i = -1; i <= 1; i++) {
      var al = at(u + i * du, v + j * dv, 3) / 255;
      r += at(u + i * du, v + j * dv, 0) * al; g += at(u + i * du, v + j * dv, 1) * al; b += at(u + i * du, v + j * dv, 2) * al; a += al;
    }
    if (a <= 0) return { r: 0, g: 0, b: 0, a: 0, lum: 1 };
    r /= a; g /= a; b /= a;
    return { r: r, g: g, b: b, a: a / 9, lum: (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 };
  }

  var cx = box.x + box.w / 2, cy = box.y + box.h / 2, n = Math.ceil(Math.sqrt(box.w * box.w + box.h * box.h) / 2 / cell) + 1;
  var dots = [];
  for (var j = -n; j <= n; j++) for (var i = -n; i <= n; i++) {
    var X = cx + (i * ca - j * sa) * cell, Y = cy + (i * sa + j * ca) * cell;
    if (X < box.x || X > box.x + box.w || Y < box.y || Y > box.y + box.h) continue;
    var s = sample((X - box.x) / box.w, (Y - box.y) / box.h);
    var d = Math.pow(Math.max(0, Math.min(1, invert ? s.lum : 1 - s.lum)), gamma);
    d = Math.max(0, Math.min(1, (d - 0.5) * contrast + 0.5)) * s.a;
    if (d < 0.02) continue;
    dots.push({ x: X, y: Y, d: d, s: s });
  }
  if (!dots.length) throw new Error("h.halftone: nothing to draw (layer empty or fully " + (invert ? "dark" : "light") + "; try invert or gamma)");

  function size(d) { // returns [lengthAlongAxis, thicknessAcross]
    if (shape === "line") return [cell * 1.02, cell * maxS * d];
    var e = cell * maxS * Math.sqrt(d);
    return [e, e];
  }
  var result, parts = [];
  if (colored) {
    dots.forEach(function (p) {
      var sz = size(p.d), w = sz[0], h = sz[1], r;
      r = shape === "dot" ? figma.createEllipse() : figma.createRectangle();
      node.parent.appendChild(r);
      r.resize(Math.max(0.01, w), Math.max(0.01, h));
      var rot = shape === "diamond" ? angle + Math.PI / 4 : angle, c = Math.cos(rot), s2 = Math.sin(rot);
      r.relativeTransform = [[c, -s2, p.x - (c * w / 2 - s2 * h / 2)], [s2, c, p.y - (s2 * w / 2 + c * h / 2)]];
      r.fills = [{ type: "SOLID", color: { r: p.s.r / 255, g: p.s.g / 255, b: p.s.b / 255 } }];
      r.name = "dot";
      parts.push(r);
    });
    result = figma.group(parts, node.parent);
  } else {
    var vertices = [], segments = [], loops = [], K = 0.5522847498;
    dots.forEach(function (p) {
      var sz = size(p.d), hx = sz[0] / 2, hy = sz[1] / 2, base = vertices.length, loop = [];
      if (shape === "dot") {
        var rr = hx;
        for (var k = 0; k < 4; k++) vertices.push({ x: p.x + rr * Math.cos(k * Math.PI / 2), y: p.y + rr * Math.sin(k * Math.PI / 2) });
        for (var q = 0; q < 4; q++) {
          var t0 = q * Math.PI / 2, t1 = (q + 1) * Math.PI / 2;
          segments.push({
            start: base + q, end: base + (q + 1) % 4,
            tangentStart: { x: -K * rr * Math.sin(t0), y: K * rr * Math.cos(t0) },
            tangentEnd: { x: K * rr * Math.sin(t1), y: -K * rr * Math.cos(t1) },
          });
          loop.push(segments.length - 1);
        }
      } else {
        var rot = shape === "diamond" ? angle + Math.PI / 4 : angle, c = Math.cos(rot), s2 = Math.sin(rot);
        [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].forEach(function (v) { vertices.push({ x: p.x + v[0] * c - v[1] * s2, y: p.y + v[0] * s2 + v[1] * c }); });
        for (var m = 0; m < 4; m++) { segments.push({ start: base + m, end: base + (m + 1) % 4 }); loop.push(segments.length - 1); }
      }
      loops.push(loop);
    });
    var minX = Infinity, minY = Infinity;
    vertices.forEach(function (v) { minX = Math.min(minX, v.x); minY = Math.min(minY, v.y); });
    vertices.forEach(function (v) { v.x -= minX; v.y -= minY; });
    var vec = figma.createVector();
    placeAbove(node, vec);
    vec.relativeTransform = [[1, 0, minX], [0, 1, minY]];
    await vec.setVectorNetworkAsync({ vertices: vertices, segments: segments, regions: [{ windingRule: "NONZERO", loops: loops }] });
    vec.fills = [H.solid(o.color || "#000000")];
    vec.strokes = [];
    vec.name = "Halftone";
    result = vec;
  }
  if (o.bg) {
    var bgr = figma.createRectangle();
    node.parent.appendChild(bgr);
    bgr.resize(box.w, box.h); bgr.x = box.x; bgr.y = box.y;
    bgr.fills = [H.solid(o.bg)]; bgr.name = "bg";
    result = figma.group([bgr, result], node.parent);
  }
  result.name = (node.name || "Layer") + " · halftone";
  if (o.keep !== true) node.visible = false;
  return result;
}

function recolorTree(n, color) {
  var paint = H.solid(color);
  if ("fills" in n && n.fills !== figma.mixed && n.fills.length) n.fills = n.fills.map(function (f) { return f.type === "IMAGE" ? f : paint; });
  if ("strokes" in n && n.strokes.length) n.strokes = n.strokes.map(function () { return paint; });
  if ("children" in n) n.children.forEach(function (c) { recolorTree(c, color); });
}

var GLOW_KEY = "fcm_glow";
var GLOW_DEFAULTS = { radius: 48, intensity: 1, spread: 0.5, core: 1, steps: 5, color: null, blend: "LINEAR_DODGE" };

function glowOpts(o) {
  o = o || {};
  var d = GLOW_DEFAULTS, out = {};
  function num(v, def, lo, hi) { v = typeof v === "number" && isFinite(v) ? v : def; return Math.max(lo, Math.min(hi, v)); }
  out.radius = num(o.radius, d.radius, 0.5, 600);
  out.intensity = num(o.intensity, d.intensity, 0, 8);
  out.spread = num(o.spread, d.spread, 0, 1);
  out.core = num(o.core, d.core, 0, 4);
  out.steps = Math.round(num(o.steps, d.steps, 3, 8));
  out.color = o.color || null;
  out.blend = o.blend === "SCREEN" ? "SCREEN" : "LINEAR_DODGE";
  if (o.name) out.name = o.name;
  return out;
}

/** The blurred, additively blended copies that make up a glow (not yet grouped). */
function glowLayers(node, o) {
  var e = (o.spread - 0.5) * 2, layers = [], weights = [], radii = [];
  for (var k = 0; k < o.steps; k++) {
    var r = o.radius / Math.pow(2, o.steps - 1 - k);
    radii.push(r);
    // `core` boosts the two tightest octaves, so the hot centre can be tuned apart from the haze
    weights.push(Math.pow(r / o.radius, e) * (k < 2 ? o.core : 1));
  }
  var wmax = Math.max.apply(null, weights);
  if (wmax <= 0) wmax = 1;
  for (var i = 0; i < o.steps; i++) {
    var total = o.intensity * (weights[i] / wmax) * 0.85, copies = Math.max(1, Math.min(6, Math.ceil(total)));
    if (total <= 0) continue;
    for (var c = 0; c < copies; c++) {
      var cl = node.clone();
      // clone() may land at page level; put it in the node's parent and copy the parent-relative transform,
      // otherwise group() keeps the absolute position and the glow drifts by the parent's offset
      var par = node.parent;
      par.appendChild(cl);
      if (par.layoutMode && par.layoutMode !== "NONE") { try { cl.layoutPositioning = "ABSOLUTE"; } catch (err) { /* older files */ } }
      cl.relativeTransform = node.relativeTransform;
      cl.name = "glow " + Math.round(radii[i]) + "px";
      if (o.color) recolorTree(cl, o.color);
      cl.effects = [{ type: "LAYER_BLUR", radius: Math.max(0.5, radii[i]), visible: true }];
      cl.blendMode = o.blend;
      cl.opacity = Math.min(1, total / copies);
      layers.push(cl);
    }
  }
  return layers;
}

function buildGlowGroup(node, o, parent, index, name) {
  var layers = glowLayers(node, o);
  if (!layers.length) throw new Error("glow settings produce no visible layers (intensity 0?)");
  var g = figma.group(layers, parent, index);
  g.name = name || "Glow";
  if (parent.layoutMode && parent.layoutMode !== "NONE") {
    try { g.layoutPositioning = "ABSOLUTE"; } catch (err) { /* older files */ }
    // the group is laid out by the frame's flow before it turns absolute; move it back onto the source layer
    var c0 = g.children[0], dx = node.absoluteTransform[0][2] - c0.absoluteTransform[0][2], dy = node.absoluteTransform[1][2] - c0.absoluteTransform[1][2];
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) { g.x += dx; g.y += dy; }
  }
  var saved = {};
  Object.keys(o).forEach(function (k) { if (k !== "name") saved[k] = o[k]; });
  g.setPluginData(GLOW_KEY, JSON.stringify({ src: node.id, opts: saved }));
  return g;
}

/**
 * Deep-Glow-style bloom: a stack of blurred copies whose radii double from a tight core to `radius`,
 * blended additively (LINEAR_DODGE) above the source. Returns the group holding the glow layers; its settings
 * are stored on the group, so the plugin's Glow tab (or h.glowUpdate) can re-tune it later.
 * o: radius (px, widest blur, default 48) · intensity (strength 0–8, default 1) · spread 0..1 (0 = tight, 1 = wide haze, default 0.5)
 *    core 0–4 (extra weight of the two tightest octaves, default 1) · steps (octaves, 3–8, default 5)
 *    color (override tint, hex) · blend (LINEAR_DODGE | SCREEN, default LINEAR_DODGE) · name
 */
function makeGlow(node, o) {
  var opts = glowOpts(o), parent = node.parent;
  return buildGlowGroup(node, opts, parent, parent.children.indexOf(node) + 1, (o && o.name) || "Glow");
}

function readGlow(g) {
  if (!g || g.type !== "GROUP") return null;
  var raw = g.getPluginData(GLOW_KEY);
  if (!raw) return null;
  try { var d = JSON.parse(raw); return d && d.src ? d : null; } catch (e) { return null; }
}

/** Rebuild a glow group from its source with new settings (merged over the stored ones). Returns the new group. */
async function updateGlow(g, patch) {
  var d = readGlow(g);
  if (!d) throw new Error("not a glow group made by h.glow");
  var src = await figma.getNodeByIdAsync(d.src);
  if (!src || src.removed) throw new Error("the glow's source layer no longer exists");
  var merged = {};
  Object.keys(d.opts).forEach(function (k) { merged[k] = d.opts[k]; });
  Object.keys(patch || {}).forEach(function (k) { merged[k] = patch[k]; });
  var opts = glowOpts(merged), parent = g.parent, index = parent.children.indexOf(g);
  var ng = buildGlowGroup(src, opts, parent, index, g.name);
  ng.visible = g.visible; ng.locked = g.locked;
  g.remove();
  return ng;
}

/** Small helper library exposed to `execute` code as `h`. */
var H = {
  rgb: function (h) { var c = hexToRgba(h); return { r: c.r, g: c.g, b: c.b }; },
  rgba: function (h, a) { var c = hexToRgba(h); if (a !== undefined) c.a = a; return c; },
  solid: function (h, opacity) {
    var c = hexToRgba(h);
    return { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: opacity !== undefined ? opacity : c.a };
  },
  gradient: function (stops, angle) {
    var a = ((angle === undefined ? 180 : angle) - 90) * Math.PI / 180;
    var cos = Math.cos(a), sin = Math.sin(a);
    return {
      type: "GRADIENT_LINEAR",
      gradientTransform: [[cos, sin, 0.5 - cos / 2 - sin / 2], [-sin, cos, 0.5 + sin / 2 - cos / 2]],
      gradientStops: stops.map(function (s, i) {
        var c = typeof s === "string" ? hexToRgba(s) : hexToRgba(s[1]);
        return { position: typeof s === "string" ? i / Math.max(1, stops.length - 1) : s[0], color: c };
      }),
    };
  },
  node: getNode,
  font: async function (family, style) {
    var f = { family: family || "Inter", style: style || "Regular" };
    await figma.loadFontAsync(f);
    return f;
  },
  loadFonts: loadNodeFonts,
  text: async function (chars, o) {
    o = o || {};
    var t = figma.createText();
    t.fontName = await H.font(o.family, o.style);
    t.characters = String(chars);
    if (o.size) t.fontSize = o.size;
    if (o.color) t.fills = [H.solid(o.color)];
    if (o.lineHeight) t.lineHeight = { unit: "PIXELS", value: o.lineHeight };
    if (o.width) { t.resize(o.width, t.height); t.textAutoResize = "HEIGHT"; }
    if (o.name) t.name = o.name;
    if (o.parent) (typeof o.parent === "string" ? await resolveParent(o.parent) : o.parent).appendChild(t);
    return t;
  },
  /** Assign props in a safe order: layoutMode → size → the rest. Shorthands: fill:'#hex', size:[w,h], padding:n|[t,r,b,l]. */
  set: function (node, props) {
    props = Object.assign({}, props);
    if (props.layoutMode) { node.layoutMode = props.layoutMode; delete props.layoutMode; }
    if (props.size) { node.resize(props.size[0], props.size[1]); delete props.size; }
    if (props.fill !== undefined) { node.fills = props.fill ? [H.solid(props.fill)] : []; delete props.fill; }
    if (props.stroke !== undefined) { node.strokes = props.stroke ? [H.solid(props.stroke)] : []; delete props.stroke; }
    if (props.padding !== undefined) {
      var p = typeof props.padding === "number" ? [props.padding, props.padding, props.padding, props.padding] : props.padding;
      node.paddingTop = p[0]; node.paddingRight = p[1]; node.paddingBottom = p[2]; node.paddingLeft = p[3];
      delete props.padding;
    }
    var late = ["layoutSizingHorizontal", "layoutSizingVertical"];
    Object.keys(props).forEach(function (k) { if (late.indexOf(k) < 0) node[k] = props[k]; });
    late.forEach(function (k) { if (props[k]) node[k] = props[k]; });
    return node;
  },
  frame: function (props, parent) {
    var f = figma.createFrame();
    f.fills = [];
    if (parent) parent.appendChild(f);
    return H.set(f, props || {});
  },
  find: function (a, b) {
    var root = b === undefined ? figma.currentPage : a, q = b === undefined ? a : b;
    return root.findOne(typeof q === "function" ? q : function (n) { return n.name === q; });
  },
  findAll: function (a, b) {
    var root = b === undefined ? figma.currentPage : a, q = b === undefined ? a : b;
    return root.findAll(typeof q === "function" ? q : function (n) { return n.name === q; });
  },
  place: place,
  vars: async function () {
    var all = await figma.variables.getLocalVariablesAsync();
    var map = {};
    all.forEach(function (v) { map[v.name] = v; });
    return map;
  },
  bind: async function (node, field, variable) {
    var v = variable;
    if (typeof v === "string") v = (await H.vars())[v] || (await figma.variables.getVariableByIdAsync(v));
    if (!v) throw new Error("Variable not found: " + variable);
    if (field === "fill" || field === "stroke") {
      var key = field + "s";
      var base = node[key].length ? node[key][0] : { type: "SOLID", color: { r: 0, g: 0, b: 0 } };
      node[key] = [figma.variables.setBoundVariableForPaint(base, "color", v)];
    } else node.setBoundVariable(field, v);
    return node;
  },
  /** Apply a linear map [a,b,c,d] (x'=a·x+c·y, y'=b·x+d·y) around the node centre: skew, shear, flip, any affine warp. */
  transform: transformAround,
  /** Isometric projection onto a cube face: h.iso(node, 'top' | 'left' | 'right', {scale}). Apply once per node. */
  iso: isoTransform,
  /** True perspective: h.perspective(node, {shrink:'top', amount:0.35} | {quad:[TL,TR,BR,BL]}). Vector → warped vector, else image-tile mesh ({grid}). Original hidden unless {keep:true}. */
  perspective: perspectiveTransform,
  /** Film grain via the native NOISE effect: h.grain(node, {amount:.35, size:1, density:.6, tone:'duo'|'mono', blend}). Frames/rects get a "Grain" overlay layer. */
  grain: makeGrain,
  /** Native progressive blur: h.progressiveBlur(node, {side:'bottom', radius:24, background?, from?, to?}). */
  progressiveBlur: makeProgressiveBlur,
  /** Halftone as one vector of dots/squares/lines: await h.halftone(node, {cell:8, shape:'dot', angle:45, color:'#111', invert?, bg?}). */
  halftone: makeHalftone,
  /** Additive multi-radius bloom above the node (see makeGlow options). Returns the glow group. */
  glow: makeGlow,
  /** Re-tune a glow made by h.glow: h.glowUpdate(group, {intensity: 3}). Returns the rebuilt group (new id). */
  glowUpdate: updateGlow,
  progress: function (done, total, note) { progress(done, total, note); },
  /** Call another bridge command from code, e.g. h.run('motion', {op:'animate', …}) — batches several commands into one undo step. */
  run: function (method, params) {
    var fn = HANDLERS[method];
    if (!fn || method === "history") throw new Error("Unknown or disallowed method for h.run: " + method);
    return fn(params || {});
  },
};

async function doExecute(p) {
  var logs = [];
  function fmt(a) {
    return a
      .map(function (x) {
        if (typeof x === "string") return x;
        try {
          return JSON.stringify(ser(x));
        } catch (e) {
          return String(x);
        }
      })
      .join(" ");
  }
  var fakeConsole = {
    log: function () { logs.push(fmt([].slice.call(arguments))); },
    info: function () { logs.push(fmt([].slice.call(arguments))); },
    warn: function () { logs.push("[warn] " + fmt([].slice.call(arguments))); },
    error: function () { logs.push("[error] " + fmt([].slice.call(arguments))); },
  };
  var fn;
  try {
    fn = new AsyncFunction("figma", "console", "args", "h", p.code);
  } catch (e) {
    throw new Error("Syntax error in code: " + e.message);
  }
  var value;
  try {
    value = await fn(figma, fakeConsole, p.args === undefined ? {} : p.args, H);
  } catch (e) {
    var err = new Error(String((e && e.message) || e) + (logs.length ? "\nlogs:\n" + logs.join("\n") : ""));
    throw err;
  }
  var res = { result: ser(value), logs: logs };
  if (p.screenshot) res.images = await screenshotTargets(p.screenshot === true ? undefined : p.screenshot, 1);
  return res;
}
// ───────────────────────── prototyping & motion ─────────────────────────

var DIRECTIONAL = { MOVE_IN: 1, MOVE_OUT: 1, PUSH: 1, SLIDE_IN: 1, SLIDE_OUT: 1 };

function buildEasing(e) {
  if (!e) return { type: "EASE_OUT" };
  if (typeof e === "string") return { type: e };
  if (e.bezier && e.bezier.length === 4) {
    return { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: e.bezier[0], y1: e.bezier[1], x2: e.bezier[2], y2: e.bezier[3] } };
  }
  if (e.spring) {
    return { type: "CUSTOM_SPRING", easingFunctionSpring: { mass: e.spring.mass || 1, stiffness: e.spring.stiffness || 200, damping: e.spring.damping || 20 } };
  }
  return { type: e.type || "EASE_OUT" };
}

function buildTransition(t) {
  if (!t || t.type === "INSTANT") return null;
  var type = t.type || "SMART_ANIMATE";
  var out = { type: type, duration: t.duration === undefined ? 0.3 : t.duration, easing: buildEasing(t.easing) };
  if (DIRECTIONAL[type]) {
    out.direction = t.direction || "LEFT";
    out.matchLayers = !!t.matchLayers;
  }
  return out;
}

function buildTrigger(p) {
  var type = p.trigger || "ON_CLICK";
  var o = p.triggerOptions || {};
  if (type === "AFTER_TIMEOUT") return { type: type, timeout: o.timeout === undefined ? 1 : o.timeout };
  if (type === "MOUSE_ENTER" || type === "MOUSE_LEAVE" || type === "MOUSE_UP" || type === "MOUSE_DOWN") return { type: type, delay: o.delay || 0 };
  if (type === "ON_KEY_DOWN") return { type: type, device: o.device || "KEYBOARD", keyCodes: o.keyCodes || [] };
  return { type: type };
}

function buildAction(p) {
  var kind = p.action || "navigate";
  if (kind === "back") return { type: "BACK" };
  if (kind === "close") return { type: "CLOSE" };
  if (kind === "url") return { type: "URL", url: p.url, openInNewTab: p.openInNewTab !== false };
  var nav = { navigate: "NAVIGATE", overlay: "OVERLAY", swap: "SWAP", change_to: "CHANGE_TO", scroll_to: "SCROLL_TO" }[kind];
  if (!nav) throw new Error("Unknown action '" + kind + "'");
  if (!p.to) throw new Error("'to' (destination node id) is required for action '" + kind + "'");
  return { type: "NODE", destinationId: p.to, navigation: nav, transition: buildTransition(p.transition), preserveScrollPosition: false };
}

function summarizeReaction(n, r) {
  var a = r.actions && r.actions.length ? r.actions[0] : r.action;
  var o = { from: { id: n.id, name: n.name }, trigger: ser(r.trigger, 3) };
  if (a) {
    o.action = a.type === "NODE" ? a.navigation : a.type;
    if (a.destinationId) o.to = a.destinationId;
    if (a.url) o.url = a.url;
    if (a.transition) o.transition = ser(a.transition, 4);
  }
  return o;
}

async function doPrototype(p) {
  var op = p.op;
  if (op === "link") {
    var from = await getNode(p.from);
    if (!("setReactionsAsync" in from)) throw new Error("Node " + from.name + " cannot have interactions");
    if (p.to) await getNode(p.to); // validate
    var reaction = { trigger: buildTrigger(p), actions: [buildAction(p)] };
    var existing = p.append === false ? [] : from.reactions.slice();
    // one reaction per trigger type: replace a previous one with the same trigger
    existing = existing.filter(function (r) { return !(r.trigger && r.trigger.type === reaction.trigger.type); });
    existing.push(reaction);
    await from.setReactionsAsync(existing);
    return { ok: true, from: from.name, reactions: from.reactions.map(function (r) { return summarizeReaction(from, r); }) };
  }
  if (op === "clear") {
    var n = await getNode(p.from);
    await n.setReactionsAsync([]);
    return { ok: true, cleared: n.name };
  }
  if (op === "list") {
    var root = p.from ? await getNode(p.from) : figma.currentPage;
    var nodes = [root].concat("findAll" in root ? root.findAll(function (x) { return "reactions" in x && x.reactions.length > 0; }) : []);
    var out = [];
    nodes.forEach(function (x) {
      if ("reactions" in x && x.reactions.length) x.reactions.forEach(function (r) { out.push(summarizeReaction(x, r)); });
    });
    return { reactions: out, flows: figma.currentPage.flowStartingPoints.map(function (f) { return { nodeId: f.nodeId, name: f.name }; }) };
  }
  if (op === "flow") {
    var cur = figma.currentPage.flowStartingPoints.map(function (f) { return { nodeId: f.nodeId, name: f.name }; });
    if (p.remove) {
      cur = cur.filter(function (f) { return f.nodeId !== p.from; });
    } else {
      var fr = await getNode(p.from);
      cur = cur.filter(function (f) { return f.nodeId !== fr.id; });
      cur.push({ nodeId: fr.id, name: p.name || fr.name });
    }
    figma.currentPage.flowStartingPoints = cur;
    return { flows: cur };
  }
  throw new Error("Unknown op '" + op + "'");
}


// ───────────────────────── native motion (Figma timeline) ─────────────────────────

var MOTION_ALIASES = {
  x: "TRANSLATION_X", y: "TRANSLATION_Y", xy: "TRANSLATION_XY", translateX: "TRANSLATION_X", translateY: "TRANSLATION_Y",
  opacity: "OPACITY", rotation: "ROTATION", rotate: "ROTATION", scale: "SCALE_XY", scaleX: "SCALE_X", scaleY: "SCALE_Y",
  width: "WIDTH", height: "HEIGHT", radius: "CORNER_RADIUS", cornerRadius: "CORNER_RADIUS", gap: "STACK_SPACING",
  itemSpacing: "STACK_SPACING", strokeWeight: "STROKE_WEIGHT", trimStart: "PATH_TRIM_START", trimEnd: "PATH_TRIM_END",
};

function motionField(prop) {
  if (prop && typeof prop === "object") return prop;
  var m = /^(fills|strokes|effects)\[(\d+)\]\.(.+)$/.exec(String(prop));
  if (m) {
    if (m[1] === "effects") return { type: "INDEXED_ITEM", collection: "effects", index: +m[2], field: m[3].toUpperCase() };
    return { type: "INDEXED_ITEM", collection: m[1], index: +m[2], propertyId: m[3] };
  }
  return { type: "PROPERTY", name: MOTION_ALIASES[prop] || String(prop).toUpperCase() };
}

function motionValue(v) {
  if (v && typeof v === "object" && v.type && "value" in v) return v;
  if (typeof v === "number") return { type: "FLOAT", value: v };
  if (typeof v === "boolean") return { type: "BOOL", value: v };
  if (typeof v === "string") return { type: "COLOR", value: hexToRgba(v) };
  if (Array.isArray(v)) return { type: "VECTOR", value: { x: v[0], y: v[1] } };
  if (v && typeof v === "object" && "x" in v) return { type: "VECTOR", value: { x: v.x, y: v.y } };
  if (v && typeof v === "object" && "r" in v) return { type: "COLOR", value: { r: v.r, g: v.g, b: v.b, a: v.a === undefined ? 1 : v.a } };
  throw new Error("Unsupported keyframe value: " + JSON.stringify(v));
}

var VECTOR_FIELDS = { SCALE_XY: 1, TRANSLATION_XY: 1 };

function motionKeys(keys, vector) {
  return keys.map(function (k) {
    if (Array.isArray(k)) k = { t: k[0], v: k[1], easing: k[2] };
    var raw = k.v !== undefined ? k.v : k.value;
    if (vector && typeof raw === "number") raw = { x: raw, y: raw };
    var o = { timelinePosition: k.t !== undefined ? k.t : k.time, value: motionValue(raw) };
    if (k.easing) o.easing = buildEasing(k.easing);
    return o;
  });
}

async function motionTarget(root, ref) {
  if (!ref) return root;
  if (/^\d+:\d+/.test(ref) || ref.indexOf(";") >= 0) return getNode(ref);
  var n = root.name === ref ? root : "findOne" in root ? root.findOne(function (x) { return x.name === ref; }) : null;
  if (!n) throw new Error("No layer named '" + ref + "' inside " + root.name);
  return n;
}

function motionSummary(n) {
  var o = { id: n.id, name: n.name };
  try { o.tracks = ser(n.manualKeyframeTracks, 6); } catch (e) {}
  try { o.styles = ser(n.animationStyles, 5); } catch (e) {}
  return o;
}

async function doMotion(p) {
  var op = p.op;
  if (op === "styles") {
    return figma.motion.figmaAnimationStyles().map(function (s) {
      return { styleId: s.styleId, name: s.name.replace("motion.preset_name.", ""), description: s.description, props: s.props };
    });
  }
  var node = p.nodeId ? await getNode(p.nodeId) : figma.currentPage.selection[0];
  if (!node) throw new Error("nodeId is required (or select a node)");
  if (op === "apply") {
    var tgt = await motionTarget(node, p.target);
    if (p.options) tgt.applyAnimationStyle(p.style, p.props || {}, p.options);
    else tgt.applyAnimationStyle(p.style, p.props || {});
    return motionSummary(tgt);
  }
  if (op === "animate") {
    var maxT = 0, applied = [];
    for (var i = 0; i < (p.tracks || []).length; i++) {
      var t = p.tracks[i];
      var target = await motionTarget(node, t.target);
      var field = motionField(t.prop);
      var kf = motionKeys(t.keys, VECTOR_FIELDS[field.name]);
      kf.forEach(function (k) { maxT = Math.max(maxT, k.timelinePosition); });
      try { target.removeManualKeyframeTrack(field); } catch (e) {}
      target.applyManualKeyframeTrack(field, { keyframes: kf });
      applied.push({ node: target.name, field: field.name || field.collection + "[" + field.index + "]", keys: kf.length });
    }
    var tl = node.timelines && node.timelines[0];
    var duration = p.duration || (tl && maxT > tl.duration ? maxT : null);
    if (tl && duration) node.setTimelineDuration(tl.id, duration);
    if (p.playback) node.playbackSettings = Object.assign({}, node.playbackSettings, p.playback);
    return { applied: applied, timelines: ser(node.timelines, 3), playback: ser(node.playbackSettings, 2) };
  }
  if (op === "remove") {
    var tg = await motionTarget(node, p.target);
    if (p.styleId) tg.removeAnimationStyle(p.styleId);
    if (p.prop) tg.removeManualKeyframeTrack(motionField(p.prop));
    return motionSummary(tg);
  }
  if (op === "clear") {
    var all = [node].concat(p.subtree === false || !("findAll" in node) ? [] : node.findAll(function () { return true; }));
    var cleared = 0;
    all.forEach(function (n) {
      try {
        (n.animationStyles || []).slice().forEach(function (s) { n.removeAnimationStyle(s.id); cleared++; });
        Object.keys(n.manualKeyframeTracks || {}).forEach(function (k) {
          try { n.removeManualKeyframeTrack(motionField(k)); cleared++; } catch (e) {}
        });
      } catch (e) {}
    });
    return { cleared: cleared };
  }
  if (op === "timeline") {
    if (p.duration) node.setTimelineDuration(node.timelines[0].id, p.duration);
    if (p.playback) node.playbackSettings = Object.assign({}, node.playbackSettings, p.playback);
    return { timelines: ser(node.timelines, 3), playback: ser(node.playbackSettings, 2) };
  }
  if (op === "read") {
    var nodes = [node].concat("findAll" in node ? node.findAll(function () { return true; }) : []);
    var out = [];
    nodes.forEach(function (n) {
      try {
        if (Object.keys(n.manualKeyframeTracks || {}).length || (n.animationStyles || []).length) out.push(motionSummary(n));
      } catch (e) {}
    });
    return { timelines: ser(node.timelines, 3), playback: ser(node.playbackSettings, 2), animated: out };
  }
  throw new Error("Unknown motion op '" + op + "'");
}

// ───────────────────────── easing ─────────────────────────

function bezier(x1, y1, x2, y2) {
  function b(s, a, c) { return 3 * a * s * (1 - s) * (1 - s) + 3 * c * s * s * (1 - s) + s * s * s; }
  function db(s, a, c) { return 3 * a * (1 - s) * (1 - s) + 6 * (c - a) * s * (1 - s) + 3 * (1 - c) * s * s; }
  return function (t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    var s = t;
    for (var i = 0; i < 8; i++) {
      var x = b(s, x1, x2) - t, d = db(s, x1, x2);
      if (Math.abs(x) < 1e-6 || Math.abs(d) < 1e-6) break;
      s -= x / d;
    }
    if (!(s >= 0 && s <= 1) || Math.abs(b(s, x1, x2) - t) > 1e-4) {
      var lo = 0, hi = 1;
      for (var j = 0; j < 40; j++) { s = (lo + hi) / 2; if (b(s, x1, x2) < t) lo = s; else hi = s; }
    }
    return b(s, y1, y2);
  };
}

function spring(mass, stiffness, damping) {
  var w0 = Math.sqrt(stiffness / mass), z = damping / (2 * Math.sqrt(stiffness * mass));
  var T = Math.min(10, -Math.log(0.001) / (Math.max(z, 0.05) * w0));
  return function (t) {
    var tau = t * T;
    if (t >= 1) return 1;
    if (z < 1) {
      var wd = w0 * Math.sqrt(1 - z * z);
      return 1 - Math.exp(-z * w0 * tau) * (Math.cos(wd * tau) + (z * w0 / wd) * Math.sin(wd * tau));
    }
    return 1 - Math.exp(-w0 * tau) * (1 + w0 * tau);
  };
}

var EASINGS = {
  linear: function (t) { return t; },
  ease: bezier(0.25, 0.1, 0.25, 1), easeIn: bezier(0.42, 0, 1, 1), easeOut: bezier(0, 0, 0.58, 1), easeInOut: bezier(0.42, 0, 0.58, 1),
  easeInQuad: function (t) { return t * t; }, easeOutQuad: function (t) { return t * (2 - t); },
  easeInOutQuad: function (t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; },
  easeInCubic: function (t) { return t * t * t; }, easeOutCubic: function (t) { return 1 - Math.pow(1 - t, 3); },
  easeInOutCubic: function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
  easeInQuart: function (t) { return t * t * t * t; }, easeOutQuart: function (t) { return 1 - Math.pow(1 - t, 4); },
  easeInOutQuart: function (t) { return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2; },
  easeInExpo: function (t) { return t === 0 ? 0 : Math.pow(2, 10 * t - 10); }, easeOutExpo: function (t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); },
  easeInOutExpo: function (t) { return t === 0 || t === 1 ? t : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2; },
  easeInBack: function (t) { return 2.70158 * t * t * t - 1.70158 * t * t; },
  easeOutBack: function (t) { return 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2); },
  easeOutElastic: function (t) { return t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1; },
  easeOutBounce: function (t) {
    var n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
  // Figma names
  EASE_IN: bezier(0.42, 0, 1, 1), EASE_OUT: bezier(0, 0, 0.58, 1), EASE_IN_AND_OUT: bezier(0.42, 0, 0.58, 1), LINEAR: function (t) { return t; },
  EASE_IN_BACK: bezier(0.3, -0.05, 0.7, -0.5), EASE_OUT_BACK: bezier(0.45, 1.45, 0.8, 1), EASE_IN_AND_OUT_BACK: bezier(0.7, -0.4, 0.4, 1.4),
  GENTLE: spring(1, 100, 15), QUICK: spring(1, 300, 20), BOUNCY: spring(1, 600, 15), SLOW: spring(1, 80, 20),
};

/** Accepts a name, [x1,y1,x2,y2], {bezier:[…]}, {spring:{…}} or a Figma Easing object. */
function easingFn(e) {
  if (!e) return EASINGS.easeInOut;
  if (typeof e === "function") return e;
  if (typeof e === "string") {
    var k = e.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
    if (EASINGS[k]) return EASINGS[k];
    if (EASINGS[e]) return EASINGS[e];
    throw new Error("Unknown easing '" + e + "'. Known: " + Object.keys(EASINGS).join(", "));
  }
  if (Array.isArray(e)) return bezier(e[0], e[1], e[2], e[3]);
  if (e.bezier) return bezier(e.bezier[0], e.bezier[1], e.bezier[2], e.bezier[3]);
  if (e.easingFunctionCubicBezier) { var b = e.easingFunctionCubicBezier; return bezier(b.x1, b.y1, b.x2, b.y2); }
  if (e.spring) return spring(e.spring.mass || 1, e.spring.stiffness || 200, e.spring.damping || 20);
  if (e.easingFunctionSpring) { var s = e.easingFunctionSpring; return spring(s.mass, s.stiffness, s.damping); }
  if (e.type) return easingFn(e.type);
  return EASINGS.easeInOut;
}

function lerpValue(a, b, u) {
  if (typeof a === "number") return a + (b - a) * u;
  if (typeof a === "string") a = hexToRgba(a);
  if (typeof b === "string") b = hexToRgba(b);
  if (Array.isArray(a)) return a.map(function (x, i) { return x + (b[i] - x) * u; });
  if (a && "r" in a) {
    var aa = a.a === undefined ? 1 : a.a, ba = b.a === undefined ? 1 : b.a;
    return { r: a.r + (b.r - a.r) * u, g: a.g + (b.g - a.g) * u, b: a.b + (b.b - a.b) * u, a: aa + (ba - aa) * u };
  }
  if (a && "x" in a) return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  return u < 1 ? a : b;
}

/** keys: [{t, v, easing}] with t in seconds or 0..1; easing applies to the segment that STARTS at the key. */
function sampleKeys(keys, t) {
  if (!keys.length) return undefined;
  if (t <= keys[0].t) return keys[0].v;
  for (var i = 0; i < keys.length - 1; i++) {
    var a = keys[i], b = keys[i + 1];
    if (t <= b.t) {
      var u = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
      return lerpValue(a.v, b.v, easingFn(a.easing)(u));
    }
  }
  return keys[keys.length - 1].v;
}

// ───────────────────────── animation capture ─────────────────────────

/** Animation state per node: transforms are applied around the node's centre relative to its base state. */
function AnimState(node, warnings) {
  this.node = node;
  this.warnings = warnings;
  this.detached = false;
  this.base = null;
  this.curScale = 1;
}

AnimState.prototype.detach = function () {
  if (this.detached) return;
  this.detached = true;
  var n = this.node, par = n.parent;
  if (par && par.type !== "PAGE" && "layoutMode" in par && par.layoutMode !== "NONE" && n.layoutPositioning !== "ABSOLUTE") {
    // keep the slot in the flow with an invisible placeholder, then float the node (rolled back afterwards)
    var x0 = n.x, y0 = n.y; // read before the placeholder shifts the flow
    var ph = figma.createFrame();
    ph.name = "__anim_placeholder";
    ph.fills = [];
    ph.resize(Math.max(n.width, 0.01), Math.max(n.height, 0.01));
    par.insertChild(par.children.indexOf(n), ph);
    try {
      ph.layoutSizingHorizontal = n.layoutSizingHorizontal === "HUG" ? "FIXED" : n.layoutSizingHorizontal;
      ph.layoutSizingVertical = n.layoutSizingVertical === "HUG" ? "FIXED" : n.layoutSizingVertical;
      if (par.layoutMode === "GRID") ph.setGridChildPosition(n.gridRowAnchorIndex, n.gridColumnAnchorIndex);
    } catch (e) {}
    n.layoutPositioning = "ABSOLUTE";
    n.x = x0;
    n.y = y0;
  }
  var t = n.relativeTransform;
  this.base = { w: n.width, h: n.height, t: t, rot: Math.atan2(-t[1][0], t[0][0]) };
  this.base.cx = t[0][2] + t[0][0] * n.width / 2 + t[0][1] * n.height / 2;
  this.base.cy = t[1][2] + t[1][0] * n.width / 2 + t[1][1] * n.height / 2;
};

/** tr = {tx, ty, rotate (deg, clockwise), scale} */
AnimState.prototype.transform = function (tr) {
  this.detach();
  var n = this.node, B = this.base;
  var s = tr.scale === undefined ? 1 : tr.scale;
  if (Math.abs(s - this.curScale) > 1e-4 && s > 0.0001) {
    if ("rescale" in n) n.rescale(s / this.curScale);
    this.curScale = s;
  }
  var w = n.width, h = n.height;
  var th = B.rot - ((tr.rotate || 0) * Math.PI) / 180;
  var c = Math.cos(th), sn = Math.sin(th);
  var m00 = c, m01 = sn, m10 = -sn, m11 = c;
  var cx = B.cx + (tr.tx || 0), cy = B.cy + (tr.ty || 0);
  n.relativeTransform = [[m00, m01, cx - (m00 * w / 2 + m01 * h / 2)], [m10, m11, cy - (m10 * w / 2 + m11 * h / 2)]];
};

var TRANSFORM_PROPS = { translateX: 1, translateY: 1, rotate: 1, scale: 1 };

function setPath(node, path, v) {
  var m = /^(fills|strokes|effects)\[(\d+)\]\.(\w+)$/.exec(path);
  if (m) {
    var arr = JSON.parse(JSON.stringify(node[m[1]]));
    if (!arr[+m[2]]) return;
    if (m[3] === "color" && typeof v === "object") {
      var target = arr[+m[2]];
      target.color = m[1] === "effects" ? { r: v.r, g: v.g, b: v.b, a: v.a } : { r: v.r, g: v.g, b: v.b };
      if (m[1] !== "effects" && v.a !== undefined) target.opacity = v.a;
    } else arr[+m[2]][m[3]] = v;
    node[m[1]] = arr;
    return;
  }
  node[path] = v;
}

/** Apply one property value. Shorthands: fill/stroke (#hex), blur (layer blur radius), width/height, radius. */
function applyAnimProp(st, prop, v, frameTr) {
  var n = st.node;
  if (TRANSFORM_PROPS[prop]) { frameTr[prop === "translateX" ? "tx" : prop === "translateY" ? "ty" : prop] = v; return; }
  if (prop === "x" || prop === "y") { st.detach(); n[prop] = v; return; }
  if (prop === "fill" || prop === "stroke") {
    var c = typeof v === "string" ? hexToRgba(v) : v;
    var key = prop + "s";
    var arr = JSON.parse(JSON.stringify(n[key]));
    if (!arr.length || arr[0].type !== "SOLID") arr = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
    arr[0].color = { r: c.r, g: c.g, b: c.b };
    arr[0].opacity = c.a === undefined ? 1 : c.a;
    n[key] = arr;
    return;
  }
  if (prop === "blur") {
    var fx = n.effects.filter(function (e) { return e.type !== "LAYER_BLUR"; });
    if (v > 0.01) fx.push({ type: "LAYER_BLUR", blurType: "NORMAL", radius: v, visible: true });
    n.effects = fx;
    return;
  }
  if (prop === "width" || prop === "height") {
    n.resize(prop === "width" ? Math.max(v, 0.01) : n.width, prop === "height" ? Math.max(v, 0.01) : n.height);
    return;
  }
  if (prop === "radius") { n.cornerRadius = Math.max(0, v); return; }
  if (prop === "scaleX" || prop === "scaleY") {
    st.detach();
    var B = st.base;
    n.resize(Math.max(0.01, prop === "scaleX" ? B.w * v : n.width), Math.max(0.01, prop === "scaleY" ? B.h * v : n.height));
    return;
  }
  setPath(n, prop, v);
}

/** Convert the native Figma timeline (manual keyframe tracks) of a subtree into capture tracks. */
function tracksFromTimeline(root, warnings) {
  var out = [];
  var nodes = [root].concat("findAll" in root ? root.findAll(function () { return true; }) : []);
  var MAP = {
    OPACITY: ["opacity", 1], TRANSLATION_X: ["translateX", 1], TRANSLATION_Y: ["translateY", 1], ROTATION: ["rotate", -1],
    SCALE_XY: ["scale", 1], SCALE_X: ["scaleX", 1], SCALE_Y: ["scaleY", 1], WIDTH: ["width", 1], HEIGHT: ["height", 1],
    CORNER_RADIUS: ["radius", 1], STROKE_WEIGHT: ["strokeWeight", 1], STACK_SPACING: ["itemSpacing", 1],
    STACK_PADDING_LEFT: ["paddingLeft", 1], STACK_PADDING_RIGHT: ["paddingRight", 1], STACK_PADDING_TOP: ["paddingTop", 1], STACK_PADDING_BOTTOM: ["paddingBottom", 1],
    STACK_COUNTER_SPACING: ["counterAxisSpacing", 1], GRID_ROW_GAP: ["gridRowGap", 1], GRID_COLUMN_GAP: ["gridColumnGap", 1],
  };
  nodes.forEach(function (n) {
    var tracks;
    try { tracks = n.manualKeyframeTracks || {}; } catch (e) { return; }
    try {
      if ((n.animationStyles || []).length) warnings.push("'" + n.name + "': animation style presets are not rendered by the fallback renderer (use export format MP4/GIF/WEBM for native rendering)");
    } catch (e) {}
    Object.keys(tracks).forEach(function (k) {
      var tr = tracks[k];
      var keys = (tr.keyframes || []).map(function (kf) {
        var v = kf.value.value;
        return { t: kf.timelinePosition, v: v, easing: kf.easing };
      }).sort(function (a, b) { return a.t - b.t; });
      if (k === "SCALE_XY") {
        var uni = keys.every(function (q) { return Math.abs(q.v.x - q.v.y) < 1e-6; });
        if (uni) out.push({ node: n, prop: "scale", keys: keys.map(function (q) { return { t: q.t, v: q.v.x, easing: q.easing }; }) });
        else {
          warnings.push("'" + n.name + "': non-uniform SCALE_XY rendered as width/height scaling");
          out.push({ node: n, prop: "scaleX", keys: keys.map(function (q) { return { t: q.t, v: q.v.x, easing: q.easing }; }) });
          out.push({ node: n, prop: "scaleY", keys: keys.map(function (q) { return { t: q.t, v: q.v.y, easing: q.easing }; }) });
        }
        return;
      }
      if (k === "TRANSLATION_XY") {
        out.push({ node: n, prop: "translateX", keys: keys.map(function (q) { return { t: q.t, v: q.v.x, easing: q.easing }; }) });
        out.push({ node: n, prop: "translateY", keys: keys.map(function (q) { return { t: q.t, v: q.v.y, easing: q.easing }; }) });
        return;
      }
      var m = MAP[k];
      if (!m) {
        warnings.push("'" + n.name + "': keyframe track " + k + " is not supported by the fallback renderer");
        return;
      }
      out.push({ node: n, prop: m[0], keys: m[1] === 1 ? keys : keys.map(function (q) { return { t: q.t, v: q.v * m[1], easing: q.easing }; }) });
    });
  });
  return out;
}

/** Normalise declarative tracks: {target, prop, keys:[[t,v,easing]…] | from/to, start, end, easing}. Times are seconds when `duration` is set, else 0..1. */
async function declarativeTracks(root, tracks, span) {
  var out = [];
  for (var i = 0; i < tracks.length; i++) {
    var t = tracks[i];
    var node = await motionTarget(root, t.target);
    var keys;
    if (t.keys) {
      keys = t.keys.map(function (k) { return Array.isArray(k) ? { t: k[0], v: k[1], easing: k[2] || t.easing } : { t: k.t, v: k.v, easing: k.easing || t.easing }; });
    } else {
      var s = t.start || 0, e = t.end === undefined ? null : t.end;
      keys = [{ t: s, v: t.from, easing: t.easing }, { t: e === null ? span : e, v: t.to }];
    }
    keys.sort(function (a, b) { return a.t - b.t; });
    out.push({ node: node, prop: t.prop, keys: keys });
  }
  return out;
}

/**
 * Per-frame rendering. Sources: `code` (per-frame JS), `tracks` (declarative keyframes with easing),
 * `timeline: true` (evaluate the node's native Figma keyframe tracks). All mutations are rolled back with one undo step.
 */
async function doCapture(p) {
  var node = await getNode(p.nodeId);
  var warnings = [];
  var fn = null;
  if (p.code) {
    try {
      fn = new AsyncFunction("figma", "node", "i", "t", "n", "h", "sec", p.code);
    } catch (e) {
      throw new Error("Syntax error in frame code: " + e.message);
    }
  }
  var duration = p.duration || null;
  if (p.timeline && !duration) {
    try { duration = node.timelines[0].duration; } catch (e) {}
  }
  var fps = p.fps || 30;
  var n = Math.max(1, Math.min(p.frames || (duration ? Math.round(duration * fps) : 30), 1800));
  var scale = p.scale || 1;
  var frames = [];
  var t0 = Date.now();
  var restore = p.restore !== false;
  if (restore) {
    figma.commitUndo(); // boundary: everything after this is reverted in one triggerUndo()
    figma.root.setPluginData("mcp_capture", String(Date.now())); // guarantees there is a change to undo
  }
  try {
    var tracks = [];
    if (p.timeline) tracks = tracks.concat(tracksFromTimeline(node, warnings));
    if (p.tracks) tracks = tracks.concat(await declarativeTracks(node, p.tracks, duration || 1));
    if (!fn && !tracks.length) throw new Error("Nothing to animate: pass `code`, `tracks`, or `timeline: true` on a node with keyframe tracks");
    var states = new Map();
    tracks.forEach(function (tr) {
      if (!states.has(tr.node)) states.set(tr.node, new AnimState(tr.node, warnings));
    });
    var timeScale = duration || 1; // track times are seconds when a duration is known, else 0..1
    for (var i = 0; i < n; i++) {
      var tt = n > 1 ? i / (n - 1) : 0;
      var sec = tt * timeScale;
      var perNode = new Map();
      for (var k = 0; k < tracks.length; k++) {
        var tr = tracks[k];
        var v = sampleKeys(tr.keys, sec);
        if (v === undefined) continue;
        var st = states.get(tr.node);
        if (!perNode.has(st)) perNode.set(st, {});
        applyAnimProp(st, tr.prop, v, perNode.get(st));
      }
      perNode.forEach(function (tf, st) {
        if (Object.keys(tf).length) st.transform(tf);
      });
      if (fn) await fn(figma, node, i, tt, n, H, sec);
      var bytes = await node.exportAsync({ format: p.format === "JPG" ? "JPG" : "PNG", constraint: { type: "SCALE", value: scale } });
      frames.push({ bytes: bytes });
      progress(i + 1, n, "frame " + (i + 1) + "/" + n);
    }
  } finally {
    if (restore) {
      figma.commitUndo();
      figma.triggerUndo();
    }
  }
  return { frames: frames, width: Math.round(node.width * scale), height: Math.round(node.height * scale), renderMs: Date.now() - t0, warnings: warnings };
}

// ───────────────────────── export ─────────────────────────

var VIDEO_FORMATS = { MP4: 1, GIF: 1, WEBM: 1 };
var VIDEO_SCALES = [0.5, 0.75, 1, 1.5, 2, 3, 4];

async function doExport(p) {
  var ids = p.nodeIds || (p.nodeId ? [p.nodeId] : figma.currentPage.selection.map(function (n) { return n.id; }));
  if (!ids.length) throw new Error("Nothing to export: pass nodeId(s) or select layers");
  var fmt = String(p.format || "PNG").toUpperCase();
  if (fmt === "JPEG") fmt = "JPG";
  var files = [];
  for (var i = 0; i < ids.length; i++) {
    var node = await getNode(ids[i]);
    var s = { format: fmt };
    if (fmt === "PNG" || fmt === "JPG" || VIDEO_FORMATS[fmt]) {
      if (p.width) s.constraint = { type: "WIDTH", value: p.width };
      else if (p.height) s.constraint = { type: "HEIGHT", value: p.height };
      else if (p.scale && p.scale !== 1) {
        var sc = p.scale;
        if (VIDEO_FORMATS[fmt]) sc = VIDEO_SCALES.reduce(function (a, b) { return Math.abs(b - sc) < Math.abs(a - sc) ? b : a; });
        s.constraint = { type: "SCALE", value: sc };
      }
    }
    if (VIDEO_FORMATS[fmt]) {
      if (p.fps) s.fps = [12, 24, 30, 60].reduce(function (a, b) { return Math.abs(b - p.fps) < Math.abs(a - p.fps) ? b : a; });
      if (p.quality) s.quality = p.quality;
    }
    if (fmt === "SVG" || fmt === "SVG_STRING") {
      if (p.svgOutlineText !== undefined) s.svgOutlineText = p.svgOutlineText;
      if (p.svgIdAttribute !== undefined) s.svgIdAttribute = p.svgIdAttribute;
      if (p.svgSimplifyStroke !== undefined) s.svgSimplifyStroke = p.svgSimplifyStroke;
    }
    if (p.contentsOnly !== undefined && fmt !== "JSON_REST_V1") s.contentsOnly = p.contentsOnly;
    if (p.useAbsoluteBounds !== undefined && fmt !== "JSON_REST_V1") s.useAbsoluteBounds = p.useAbsoluteBounds;
    var t0 = Date.now();
    var data;
    try {
      data = await node.exportAsync(s);
    } catch (e) {
      var msg = String((e && e.message) || e);
      if (VIDEO_FORMATS[fmt]) msg += ". Native video export needs a node with timeline animation (motion tracks/styles) and the Figma window in the foreground; capture_animation with timeline:true is the fallback.";
      throw new Error(msg);
    }
    var f = { nodeId: node.id, name: node.name, format: fmt, width: Math.round(node.width), height: Math.round(node.height), ms: Date.now() - t0 };
    if (fmt === "JSON_REST_V1") f.json = data;
    else if (fmt === "SVG_STRING") f.text = data;
    else f.bytes = data;
    files.push(f);
    progress(i + 1, ids.length, node.name);
  }
  return { files: files };
}

// ───────────────────────── Figma → HTML / JSX ─────────────────────────

var VECTORISH = { VECTOR: 1, STAR: 1, POLYGON: 1, LINE: 1, BOOLEAN_OPERATION: 1 };

function hasImageFill(n) {
  return "fills" in n && n.fills !== figma.mixed && n.fills.some(function (f) { return f.type === "IMAGE" && f.visible !== false; });
}

function isIconLike(n) {
  if (VECTORISH[n.type]) return true;
  if (!("children" in n) || n.width > 160 || n.height > 160) return false;
  var all = n.findAll(function () { return true; });
  if (!all.length) return false;
  return all.every(function (c) {
    return (VECTORISH[c.type] || c.type === "GROUP" || c.type === "ELLIPSE" || c.type === "RECTANGLE" || c.type === "FRAME") && !hasImageFill(c);
  }) && all.some(function (c) { return VECTORISH[c.type]; });
}

function esc(s) {
  return String(s).replace(/[&<>"{}]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "{": "&#123;", "}": "&#125;" }[c]; });
}

function slug(s) {
  var x = String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  if (!x || /^\d/.test(x)) x = "n-" + x;
  return x;
}

function rgbaCss(p) {
  var a = (p.opacity === undefined ? 1 : p.opacity) * (p.color.a === undefined ? 1 : p.color.a);
  if (a >= 0.999) return hex(p.color);
  return "rgba(" + Math.round(p.color.r * 255) + "," + Math.round(p.color.g * 255) + "," + Math.round(p.color.b * 255) + "," + round(a) + ")";
}

function imageMime(bytes) {
  if (bytes[0] === 0x89) return ["image/png", "png"];
  if (bytes[0] === 0xff) return ["image/jpeg", "jpg"];
  if (bytes[0] === 0x47) return ["image/gif", "gif"];
  return ["image/webp", "webp"];
}

function CodeCtx(opts) {
  this.rules = [];
  this.names = {};
  this.assets = [];
  this.assetByHash = {};
  this.opts = opts;
  this.warnings = [];
  this.count = 0;
}

CodeCtx.prototype.cls = function (name, css) {
  var base = slug(name), c = base, i = 2;
  while (this.names[c]) c = base + "-" + i++;
  this.names[c] = 1;
  var body = Object.keys(css).filter(function (k) { return css[k] !== undefined && css[k] !== ""; }).map(function (k) { return "  " + k + ": " + css[k] + ";"; }).join("\n");
  this.rules.push("." + c + " {\n" + body + "\n}");
  return c;
};

CodeCtx.prototype.image = async function (hash) {
  if (this.assetByHash[hash]) return this.assetByHash[hash];
  var mode = this.opts.images || "inline";
  var src = "";
  if (mode !== "none") {
    var img = figma.getImageByHash(hash);
    var bytes = img ? await img.getBytesAsync() : null;
    if (bytes) {
      var mt = imageMime(bytes);
      if (mode === "files") {
        var path = "assets/" + hash.slice(0, 12) + "." + mt[1];
        this.assets.push({ path: path, bytes: bytes });
        src = path;
      } else src = "data:" + mt[0] + ";base64," + figma.base64Encode(bytes);
    }
  }
  this.assetByHash[hash] = src;
  return src;
};

async function nodeToHtml(n, parent, origin, cx, depth) {
  if ("visible" in n && !n.visible) return "";
  if (n.isMask) { cx.warnings.push("mask '" + n.name + "' skipped"); return ""; }
  cx.count++;
  progress(cx.count, 0, n.name);
  var css = {};
  try { css = await n.getCSSAsync(); } catch (e) {}
  var pad = new Array(depth + 1).join("  ");
  var parentFlow = parent && "layoutMode" in parent && parent.layoutMode !== "NONE" && !(n.layoutPositioning === "ABSOLUTE");
  if (parent && !parentFlow && !(css.position === "absolute" && (css.left || css.right) && (css.top || css.bottom))) {
    // Figma's CSS omits positions for children of non-auto-layout frames: place them from x/y
    ["left", "right", "top", "bottom"].forEach(function (k) { delete css[k]; });
    css.position = "absolute";
    css.left = round(n.x - origin.x) + "px";
    css.top = round(n.y - origin.y) + "px";
    if (n.rotation) css["transform-origin"] = "0 0";
  }
  if (!parent) css.position = "relative";
  // images
  if (hasImageFill(n) && css.background && css.background.indexOf("<path-to-image>") >= 0) {
    var imgs = n.fills.filter(function (f) { return f.type === "IMAGE" && f.visible !== false; });
    var bg = css.background;
    for (var i = 0; i < imgs.length; i++) bg = bg.replace("<path-to-image>", await cx.image(imgs[i].imageHash));
    css.background = bg;
  }
  // vectors / icons → SVG
  if (isIconLike(n)) {
    var svg = "";
    try { svg = await n.exportAsync({ format: "SVG_STRING", svgIdAttribute: false }); } catch (e) {}
    var box = { width: css.width, height: css.height, position: css.position, left: css.left, top: css.top, "flex-shrink": "0", transform: css.transform, "transform-origin": css["transform-origin"], opacity: css.opacity };
    var c0 = cx.cls(n.name, box);
    if (cx.opts.format === "jsx" || !svg) {
      var src = svg ? "data:image/svg+xml;base64," + figma.base64Encode(new Uint8Array(Array.from(unescape(encodeURIComponent(svg))).map(function (ch) { return ch.charCodeAt(0); }))) : "";
      return pad + '<img class="' + c0 + '" src="' + src + '" alt="' + esc(n.name) + '" />\n';
    }
    return pad + '<div class="' + c0 + '">' + svg.replace(/\s*\n\s*/g, " ") + "</div>\n";
  }
  if (n.type === "TEXT") {
    if (n.textAutoResize === "WIDTH_AND_HEIGHT") css["white-space"] = "nowrap";
    else css["white-space"] = "pre-wrap";
    var c1 = cx.cls(n.name, css);
    var segs = [];
    try { segs = n.getStyledTextSegments(["fontName", "fontSize", "fontWeight", "fills", "textDecoration", "letterSpacing", "hyperlink", "textCase"]); } catch (e) {}
    var inner = "";
    if (segs.length <= 1) inner = esc(n.characters).replace(/\n/g, "<br />");
    else {
      segs.forEach(function (s, idx) {
        var sc = {};
        if (s.fontWeight) sc["font-weight"] = s.fontWeight;
        if (s.fontSize) sc["font-size"] = s.fontSize + "px";
        if (/italic/i.test(s.fontName.style)) sc["font-style"] = "italic";
        sc["font-family"] = '"' + s.fontName.family + '"';
        var solid = (s.fills || []).filter(function (f) { return f.type === "SOLID"; })[0];
        if (solid) sc.color = rgbaCss(solid);
        if (s.textDecoration === "UNDERLINE") sc["text-decoration"] = "underline";
        if (s.textDecoration === "STRIKETHROUGH") sc["text-decoration"] = "line-through";
        if (s.textCase === "UPPER") sc["text-transform"] = "uppercase";
        var sc1 = cx.cls(n.name + "-run" + (idx + 1), sc);
        var txt = esc(s.characters).replace(/\n/g, "<br />");
        if (s.hyperlink && s.hyperlink.type === "URL") inner += '<a class="' + sc1 + '" href="' + esc(s.hyperlink.value) + '">' + txt + "</a>";
        else inner += '<span class="' + sc1 + '">' + txt + "</span>";
      });
    }
    var tag = n.fontSize !== figma.mixed && n.fontSize >= 28 ? "h2" : "p";
    return pad + "<" + tag + ' class="' + c1 + '">' + inner + "</" + tag + ">\n";
  }
  var kids = "children" in n ? n.children : [];
  var childOrigin = origin;
  if (n.type === "GROUP" || n.type === "BOOLEAN_OPERATION") {
    childOrigin = { x: n.x, y: n.y };
  } else childOrigin = { x: 0, y: 0 };
  var needsRel = kids.some(function (k) { return !("layoutMode" in n) || n.layoutMode === "NONE" || k.layoutPositioning === "ABSOLUTE"; });
  if (needsRel && css.position !== "absolute") css.position = "relative";
  if ("clipsContent" in n && n.clipsContent) css.overflow = "hidden";
  var c2 = cx.cls(n.name, css);
  var body = "";
  for (var j = 0; j < kids.length; j++) body += await nodeToHtml(kids[j], n, childOrigin, cx, depth + 1);
  return pad + '<div class="' + c2 + '">\n' + body + pad + "</div>\n";
}

async function doToCode(p) {
  var root = p.nodeId ? await getNode(p.nodeId) : figma.currentPage.selection[0];
  if (!root) throw new Error("nodeId is required (or select a node)");
  var cx = new CodeCtx({ format: p.format || "html", images: p.images || "inline" });
  var markup = await nodeToHtml(root, null, { x: 0, y: 0 }, cx, p.format === "jsx" ? 2 : 1);
  var css = "* { box-sizing: border-box; margin: 0; }\n" + cx.rules.join("\n");
  var code;
  if (cx.opts.format === "jsx") {
    var comp = slug(root.name).split("-").map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join("").replace(/^N(?=[A-Z0-9])/, "") || "Design";
    if (/^\d/.test(comp)) comp = "Design" + comp;
    var jsx = markup.replace(/ class="/g, ' className="').replace(/<br \/>/g, "<br />");
    code = "import \"./" + comp + ".css\";\n\nexport default function " + comp + "() {\n  return (\n" + jsx + "  );\n}\n";
    return { component: comp, jsx: code, css: css, assets: cx.assets, nodes: cx.count, warnings: cx.warnings };
  }
  code = '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>' + esc(root.name) + "</title>\n<style>\n" + css + "\n</style>\n</head>\n<body>\n" + markup + "</body>\n</html>\n";
  return { html: code, assets: cx.assets, nodes: cx.count, warnings: cx.warnings };
}

// ───────────────────────── libraries & users ─────────────────────────

async function doLibrary(p) {
  var op = p.op;
  if (op === "collections") {
    return (await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()).map(function (c) {
      return { key: c.key, name: c.name, library: c.libraryName };
    });
  }
  if (op === "variables") {
    return (await figma.teamLibrary.getVariablesInLibraryCollectionAsync(p.key)).map(function (v) {
      return { key: v.key, name: v.name, type: v.resolvedType };
    });
  }
  if (op === "import_variable") {
    var v = await figma.variables.importVariableByKeyAsync(p.key);
    return { id: v.id, name: v.name, type: v.resolvedType };
  }
  if (op === "import_component" || op === "import_component_set") {
    var c = op === "import_component" ? await figma.importComponentByKeyAsync(p.key) : await figma.importComponentSetByKeyAsync(p.key);
    var res = { id: c.id, name: c.name, type: c.type };
    if (c.type === "COMPONENT_SET") res.variants = c.children.map(function (k) { return { id: k.id, name: k.name }; });
    if (p.instance !== false) {
      var main = c.type === "COMPONENT_SET" ? c.defaultVariant : c;
      var inst = main.createInstance();
      await place(inst, p.parentId, p.x, p.y);
      res.instanceId = inst.id;
    }
    return res;
  }
  if (op === "import_style") {
    var st = await figma.importStyleByKeyAsync(p.key);
    return { id: st.id, name: st.name, type: st.type };
  }
  if (op === "users") {
    var out = {};
    try { out.currentUser = ser(figma.currentUser, 2); } catch (e) { out.currentUser = String(e.message || e); }
    try { out.activeUsers = ser(figma.activeUsers, 2); } catch (e) { out.activeUsers = String(e.message || e); }
    return out;
  }
  throw new Error("Unknown library op '" + op + "'");
}

// ───────────────────────── history: transactional undo ─────────────────────────

var TX = { seq: 0, ops: [] };
var TX_KEY = "mcp_tx";

/** Run a mutating command as ONE undo step, marked with a sentinel so it can be undone (and rolled back on error). */
async function runTx(method, params, fn) {
  var prev = figma.root.getPluginData(TX_KEY);
  figma.commitUndo();
  var seq = ++TX.seq;
  figma.root.setPluginData(TX_KEY, "op" + seq); // undoable marker: guarantees the step is non-empty and identifies it
  var result;
  try {
    result = await fn();
  } catch (e) {
    var msg = String((e && e.message) || e);
    if (params.atomic !== false) {
      figma.commitUndo();
      figma.triggerUndo();
      TX.seq--;
      msg += " — all changes made by this call were rolled back";
    } else {
      figma.commitUndo();
      TX.ops.push({ seq: seq, prev: prev, method: method, note: "failed: " + msg.slice(0, 60), at: Date.now() });
    }
    throw new Error(msg);
  }
  figma.commitUndo();
  TX.ops.push({ seq: seq, prev: prev, method: method, note: txNote(method, params), at: Date.now() });
  if (TX.ops.length > 300) TX.ops.shift();
  return result;
}

function txNote(method, p) {
  if (method === "execute") return String(p.code || "").replace(/\s+/g, " ").slice(0, 70);
  if (method === "build_tree") return "render_html " + (p.name || (p.tree && p.tree.name) || "");
  if (method === "prototype" || method === "motion" || method === "library") return p.op || "";
  return "";
}

async function doHistory(p) {
  var op = p.op || "list";
  if (op === "list") {
    var now = Date.now();
    return {
      undoable: TX.ops.slice(-50).reverse().map(function (o) {
        return { seq: o.seq, method: o.method, note: o.note, ago: Math.round((now - o.at) / 1000) + "s" };
      }),
      hint: "undo {steps:n} reverts the newest n bridge operations; undo {to:seq} reverts everything after seq. Manual edits made after a bridge operation stop the undo.",
    };
  }
  if (op === "version") {
    var v = await figma.saveVersionHistoryAsync(p.title || "MCP checkpoint", p.description || "");
    return { versionId: v.id, title: p.title || "MCP checkpoint", note: "Visible in File → Version history. Restoring is done by the user in Figma." };
  }
  if (op === "undo") {
    var steps = p.steps || 1;
    if (p.to !== undefined) steps = TX.ops.filter(function (o) { return o.seq > p.to; }).length;
    var undone = [];
    figma.commitUndo();
    for (var i = 0; i < steps; i++) {
      var top = TX.ops[TX.ops.length - 1];
      if (!top) break;
      var cur = figma.root.getPluginData(TX_KEY);
      if (cur !== "op" + top.seq) {
        return { undone: undone, stopped: "The newest undo step in this file was not made by the bridge (the user undid or changed something). Stopped to protect manual work.", remaining: TX.ops.length };
      }
      figma.triggerUndo();
      var after = figma.root.getPluginData(TX_KEY);
      if (after === cur) {
        await new Promise(function (r) { setTimeout(r, 60); });
        after = figma.root.getPluginData(TX_KEY);
      }
      if (after === cur) {
        return {
          undone: undone,
          stopped: "Undo reverted a manual edit made after bridge op #" + top.seq + " instead of the op itself. Press Ctrl/Cmd+Shift+Z in Figma to restore it.",
          remaining: TX.ops.length,
        };
      }
      TX.ops.pop();
      undone.push({ seq: top.seq, method: top.method, note: top.note });
    }
    return { undone: undone, remaining: TX.ops.length };
  }
  throw new Error("Unknown history op '" + op + "'");
}

// ───────────────────────── other commands ─────────────────────────

async function doInfo() {
  return {
    fileName: figma.root.name,
    pageName: figma.currentPage.name,
    pageId: figma.currentPage.id,
    editorType: figma.editorType,
    selection: figma.currentPage.selection.map(function (n) { return { id: n.id, name: n.name, type: n.type }; }),
    topLevel: figma.currentPage.children.length,
    undoable: TX.ops.length,
  };
}

// Glow tab (plugin UI): edit a glow group's settings live. These are user edits, not bridge operations, so they
// stay out of the MCP history; commitUndo keeps one slider drag as one Figma undo step.
function insideGlow(n) {
  for (var p = n.parent; p && p.type !== "PAGE"; p = p.parent) if (readGlow(p)) return true;
  return false;
}

async function doGlowGet() {
  var sel = figma.currentPage.selection;
  if (sel.length !== 1) return { mode: "none", defaults: GLOW_DEFAULTS };
  var n = sel[0], d = readGlow(n);
  if (d) {
    var src = await figma.getNodeByIdAsync(d.src);
    return { mode: "glow", id: n.id, opts: glowOpts(d.opts), defaults: GLOW_DEFAULTS, source: src && !src.removed ? src.name : null };
  }
  if (n.type === "PAGE" || n.type === "DOCUMENT" || !("clone" in n) || insideGlow(n)) return { mode: "none", defaults: GLOW_DEFAULTS };
  return { mode: "add", id: n.id, name: n.name, defaults: GLOW_DEFAULTS };
}

async function doGlowSet(p) {
  var g = await figma.getNodeByIdAsync(p.id);
  if (!g) throw new Error("glow group not found");
  if (p.phase === "start" || p.phase === "both") figma.commitUndo();
  var ng = await updateGlow(g, p.patch);
  figma.currentPage.selection = [ng];
  if (p.phase === "end" || p.phase === "both") figma.commitUndo();
  return { id: ng.id, opts: glowOpts(readGlow(ng).opts) };
}

async function doGlowAdd(p) {
  var n = await figma.getNodeByIdAsync(p.id);
  if (!n) throw new Error("layer not found");
  figma.commitUndo();
  var g = makeGlow(n, p.opts || {});
  figma.currentPage.selection = [g];
  figma.commitUndo();
  return { id: g.id };
}

async function doInsertSvg(p) {
  var node = figma.createNodeFromSvg(p.svg);
  if (p.name) node.name = p.name;
  await place(node, p.parentId, p.x, p.y);
  figma.currentPage.selection = [node];
  return { nodeId: node.id, size: { w: Math.round(node.width), h: Math.round(node.height) } };
}

async function doPlaceImage(p) {
  var img = figma.createImage(p.bytes);
  var fill = { type: "IMAGE", scaleMode: p.scaleMode || "FILL", imageHash: img.hash };
  var node;
  if (p.targetNodeId) {
    node = await getNode(p.targetNodeId);
    if (!("fills" in node)) throw new Error("Target node has no fills");
    node.fills = [fill];
  } else {
    node = figma.createRectangle();
    node.name = p.name || "Image";
    node.resize(p.width || 100, p.height || 100);
    node.fills = [fill];
    await place(node, p.parentId, p.x, p.y);
  }
  figma.currentPage.selection = [node];
  var res = { nodeId: node.id, size: { w: Math.round(node.width), h: Math.round(node.height) } };
  if (p.warnings && p.warnings.length) res.warnings = p.warnings;
  res.images = [await exportNode(node, 1)];
  return res;
}

async function doPlaceVideo(p) {
  var video = await figma.createVideoAsync(p.bytes);
  var fill = { type: "VIDEO", scaleMode: p.scaleMode || "FILL", videoHash: video.hash };
  var node;
  if (p.targetNodeId) {
    node = await getNode(p.targetNodeId);
    node.fills = [fill];
  } else {
    node = figma.createRectangle();
    node.name = p.name || "Video";
    node.resize(p.width || 640, p.height || 360);
    node.fills = [fill];
    await place(node, p.parentId, p.x, p.y);
  }
  figma.currentPage.selection = [node];
  return { nodeId: node.id, videoHash: video.hash, size: { w: Math.round(node.width), h: Math.round(node.height) } };
}

async function doPage(p) {
  if (p.op === "list" || !p.op) {
    return figma.root.children.map(function (pg) { return { id: pg.id, name: pg.name, current: pg === figma.currentPage }; });
  }
  if (p.op === "switch") {
    var pg = figma.root.children.find(function (x) { return x.id === p.page || x.name === p.page; });
    if (!pg) throw new Error("No page '" + p.page + "'");
    await figma.setCurrentPageAsync(pg);
    return { current: pg.name, id: pg.id };
  }
  throw new Error("Unknown page op");
}

var CURRENT_ID = null;
var lastProgress = 0;
function progress(done, total, note) {
  var now = Date.now();
  if (now - lastProgress < 300 && done !== total) return;
  lastProgress = now;
  if (CURRENT_ID !== null) figma.ui.postMessage({ type: "progress", id: CURRENT_ID, done: done, total: total, note: note || "" });
}

var HANDLERS = {
  info: doInfo,
  execute: doExecute,
  read: doRead,
  screenshot: async function (p) {
    return { images: await screenshotTargets(p.nodeId, p.scale) };
  },
  build_tree: buildTree,
  insert_svg: doInsertSvg,
  place_image: doPlaceImage,
  place_video: doPlaceVideo,
  prototype: doPrototype,
  motion: doMotion,
  capture: doCapture,
  export: doExport,
  to_code: doToCode,
  library: doLibrary,
  history: doHistory,
  page: doPage,
  glow_get: doGlowGet,
  glow_set: doGlowSet,
  glow_add: doGlowAdd,
};

var MUTATING = { execute: 1, build_tree: 1, insert_svg: 1, place_image: 1, place_video: 1, prototype: 1, library: 1 };
var READONLY_OPS = { prototype: { list: 1 }, motion: { styles: 1, read: 1 }, library: { collections: 1, variables: 1, users: 1 } };

function isMutating(method, params) {
  if (method === "motion") return !READONLY_OPS.motion[params.op];
  if (!MUTATING[method]) return false;
  var ro = READONLY_OPS[method];
  return !(ro && ro[params.op]);
}

function pushInfo() {
  doInfo().then(function (i) {
    figma.ui.postMessage({ type: "info", info: i });
  });
}
figma.on("selectionchange", pushInfo);
figma.on("currentpagechange", pushInfo);

// Commands run strictly one after another: interleaved calls would break undo-step boundaries.
var QUEUE = Promise.resolve();

figma.ui.onmessage = function (msg) {
  if (msg.method && msg.method !== "info") {
    QUEUE = QUEUE.then(function () { return handleMessage(msg); }, function () { return handleMessage(msg); });
    return;
  }
  return handleMessage(msg);
};

async function handleMessage(msg) {
  if (msg.type === "save_port") {
    figma.clientStorage.setAsync("port", msg.port);
    return;
  }
  if (msg.type === "sample_reply") {
    var w = SAMPLE_WAITERS[msg.id];
    if (!w) return;
    clearTimeout(w.t);
    delete SAMPLE_WAITERS[msg.id];
    if (msg.error) w.reject(new Error(msg.error)); else w.resolve({ w: msg.w, h: msg.h, data: msg.data });
    return;
  }
  if (msg.type === "notify") {
    figma.notify(msg.text, { timeout: 2000 });
    return;
  }
  if (!msg.method) return;
  CURRENT_ID = msg.id;
  try {
    var h = HANDLERS[msg.method];
    if (!h) throw new Error("Unknown method: " + msg.method);
    var params = msg.params || {};
    var result = isMutating(msg.method, params)
      ? await runTx(msg.method, params, function () { return h(params); })
      : await h(params);
    figma.ui.postMessage({ type: "reply", id: msg.id, result: result });
  } catch (e) {
    figma.ui.postMessage({ type: "reply", id: msg.id, error: String((e && e.message) || e) });
  } finally {
    CURRENT_ID = null;
  }
}
