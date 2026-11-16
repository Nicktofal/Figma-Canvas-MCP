#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { Bridge, type Progress } from "./bridge.js";
import { loadSkills } from "./skills.js";
import { ffmpegArgs, findFfmpeg, run as ffmpegRun } from "./media.js";

const VERSION = "0.3.0";
const PORT = Number(process.env.FIGMA_MCP_PORT ?? 3055);
const bridge = new Bridge(PORT);
await bridge.start();

// Sent to every MCP client on connect (any model, any client). Keep it short: details live in the `skills` tool.
const INSTRUCTIONS = [
  "Figma Canvas MCP: edits the open Figma file through the Plugin API. Start with `status`; it fails until the user runs the plugin in Figma.",
  "Tools: render_html (HTML/Tailwind → Auto Layout/GRID, best for whole screens), execute (any Plugin API code; helpers `h`, data via `args`), read, screenshot, motion + export (native keyframes → MP4/GIF), capture_animation, to_code, compare, prototype, history (undo), library, insert_asset, render_shader, page, figma_rest.",
  "Before non-trivial work call `skills` with name `core` (workflow, pitfalls). Always-on defaults, apply silently and never ask the user about them: follow the brief and existing file context first (`read` target 'file'); one primary action and one focal point; one grid and a 4/8/16/24/32/48/64 spacing scale; 1–2 fonts, clear type scale, body 16; neutral surfaces with a single accent; no gradient text, no purple-blue gradients, no emoji icons, no nested cards, no lorem ipsum or invented stats; contrast ≥ 4.5:1; motion only to explain change (ease-out, 150–500 ms).",
  "Work in few, large calls (each is one atomic undo step), check the result image or `read` output, fix problems yourself, and report briefly with node ids and any warnings.",
].join("\n");

const server = new McpServer({ name: "figma-canvas-mcp", version: VERSION }, { instructions: INSTRUCTIONS });
const IMAGES = process.env.FIGMA_MCP_IMAGES !== "0"; // set 0 for models/clients without image input

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const text = (t: string): Content => ({ type: "text", text: t });
const json = (v: unknown): Content => text(typeof v === "string" ? v : JSON.stringify(v, null, 2));
const image = (b64: string, mimeType = "image/png"): Content => ({ type: "image", data: b64, mimeType });

/** Wrap a handler so bridge errors become tool errors instead of protocol errors. */
function run(fn: () => Promise<Content[]>) {
  return fn().then(
    (content) => ({ content: IMAGES ? content : content.filter((c) => c.type !== "image") }),
    (err: Error) => ({ content: [text(`Error: ${err.message}`)], isError: true as const })
  );
}

/** MCP progress notifications for long plugin operations (render, capture, export). */
function progressOf(extra: any): Progress | undefined {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra?.sendNotification) return undefined;
  return (p) => {
    extra
      .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: p.done, total: p.total || undefined, message: p.note } })
      .catch(() => {});
  };
}

/** Split plugin results into JSON + inline screenshots. */
function withImages(result: any): Content[] {
  const out: Content[] = [];
  const { images, ...rest } = result ?? {};
  out.push(json(rest));
  for (const img of images ?? []) {
    out.push(text(`Screenshot of ${img.name ?? img.nodeId} (${img.nodeId}, ${img.width}×${img.height})`));
    out.push(image(img.base64));
  }
  return out;
}

const NODE_ID = /^I?\d+[:;-]\d+/;

/** Read binary input from a local path, an http(s) URL or base64. */
async function loadBinary(src: string): Promise<Buffer> {
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Fetching ${src} failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  if (/^data:[^;]+;base64,/.test(src)) return Buffer.from(src.slice(src.indexOf(",") + 1), "base64");
  try {
    return await readFile(resolve(src));
  } catch (e) {
    if (/^[A-Za-z0-9+/=\s]{64,}$/.test(src)) return Buffer.from(src, "base64");
    throw new Error(`Cannot read '${src.slice(0, 80)}': ${(e as Error).message}`);
  }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const safeName = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "node";

// ───────────────────────── status / connection ─────────────────────────

server.registerTool(
  "status",
  {
    description:
      "Check whether the Figma plugin is connected and which file/page/selection it sees. Lists every connected file (one plugin window per open file); pass `use` (file name or connection id) to direct this agent's following calls to that file (other agent sessions keep their own target). Call this first if anything fails.",
    inputSchema: { use: z.string().optional().describe("Switch the target file: connection id or (part of) the file name.") },
  },
  ({ use }) =>
    run(async () => {
      if (use) await bridge.use(use);
      const st = await bridge.state();
      if (!st.connected) {
        return [
          text(
            bridge.listenError ??
              "Plugin NOT connected. In Figma open the target file, then Plugins → Development → Figma Canvas MCP."
          ),
        ];
      }
      const info = await bridge.call("info");
      return [json({ connected: true, server: VERSION, role: bridge.role, ...info, connections: st.connections })];
    })
);

// ───────────────────────── core: execute / read / screenshot ─────────────────────────

server.registerTool(
  "execute",
  {
    description:
      "Run JavaScript inside the Figma plugin sandbox with full access to the Plugin API (`figma.*`). The code is the body of an async function: use `await`, and `return` a JSON-serialisable value (nodes are auto-converted to {id,name,type}). " +
      "In scope: `figma`, `console` (output returned in `logs`), `args` (the JSON you pass in `args` — use it for large data instead of string-building code), and `h`, a helper library: " +
      "h.solid('#hex',opacity), h.rgb('#hex'), h.rgba('#hex',a), h.gradient(['#a','#b'],angleDeg), h.font(family,style) (loads it), h.loadFonts(node) (all fonts in a subtree), " +
      "h.text(chars,{family,style,size,color,width,lineHeight,name,parent}), h.frame(props,parent), h.set(node,{layoutMode,size:[w,h],fill:'#hex',padding,...any prop}), h.find(name|fn) / h.find(root,name), h.findAll(...), h.node(id), h.vars() (name→Variable), h.bind(node,'fill'|'itemSpacing'|…, varName), h.run(method, params) (call another bridge command such as motion/prototype/build_tree inside the same undo step). " +
      "Each call is ONE undo step and is atomic: if the code throws, everything it changed is rolled back (set atomic:false to keep partial changes). Prefer ONE call that builds a whole structure. Set `screenshot` to verify the visual result.",
    inputSchema: {
      code: z.string().describe("Body of an async function. `figma`, `args`, `h`, `console` are in scope."),
      args: z.any().optional().describe("JSON data passed to the code as `args`."),
      screenshot: z
        .union([z.boolean(), z.string(), z.array(z.string())])
        .optional()
        .describe("true = screenshot the selection afterwards; a node id (or array of up to 6 ids) = screenshot those nodes."),
      atomic: z.boolean().optional().describe("Roll back all changes if the code throws (default true)."),
      timeoutMs: z.number().int().positive().max(600_000).optional(),
    },
  },
  ({ code, args, screenshot, atomic, timeoutMs }, extra) =>
    run(async () => withImages(await bridge.call("execute", { code, args, screenshot, atomic }, timeoutMs ?? 60_000, progressOf(extra))))
);

server.registerTool(
  "read",
  {
    description:
      "Inspect the document without writing code. target: 'selection' (default), 'page', 'file' (pages, local variables with scopes, paint/text/effect/grid/animation styles, components), or a node id. " +
      "Returns a compact tree (id, name, type, geometry, auto-layout incl. GRID, grid cell, fills, strokes, effects, blend mode, text, interactions, motion tracks).",
    inputSchema: {
      target: z.string().optional().describe("'selection' | 'page' | 'file' | node id"),
      depth: z.number().int().min(0).max(12).optional().describe("Child levels to include (default 3)."),
    },
  },
  ({ target, depth }) =>
    run(async () => [json(await bridge.call("read", { target: target ?? "selection", depth: depth ?? 3 }))])
);

server.registerTool(
  "screenshot",
  {
    description:
      "PNG of a node (default: current selection, else the current page's last top-level node). Use it to visually check your work. For files on disk or other formats use `export`.",
    inputSchema: {
      nodeId: z.union([z.string(), z.array(z.string())]).optional().describe("Node id or up to 6 ids."),
      scale: z.number().min(0.1).max(4).optional().describe("Default 1 (max 2048 px on the long side)."),
    },
  },
  ({ nodeId, scale }) => run(async () => withImages(await bridge.call("screenshot", { nodeId, scale: scale ?? 1 })))
);

server.registerTool(
  "page",
  {
    description: "List pages of the file or switch the current page (all tools work on the current page).",
    inputSchema: { op: z.enum(["list", "switch"]).optional(), page: z.string().optional().describe("Page id or name for op='switch'.") },
  },
  (a) => run(async () => [json(await bridge.call("page", a))])
);

// ───────────────────────── history ─────────────────────────

server.registerTool(
  "history",
  {
    description:
      "Transactional undo for bridge operations. Every mutating call (execute, render_html, insert_asset, prototype, motion, library imports) is ONE undo step. " +
      "op='list' shows undoable operations (newest first); 'undo' reverts the newest `steps` operations (or all after `to` seq) — it stops instead of undoing manual edits made by the user; " +
      "'version' saves a named entry in Figma's version history (do this before big or risky changes; restoring is done by the user in Figma).",
    inputSchema: {
      op: z.enum(["list", "undo", "version"]),
      steps: z.number().int().min(1).max(100).optional(),
      to: z.number().int().optional().describe("op='undo': revert everything after this seq."),
      title: z.string().optional(),
      description: z.string().optional(),
    },
  },
  (a) => run(async () => [json(await bridge.call("history", a))])
);

// ───────────────────────── build ─────────────────────────

server.registerTool(
  "render_html",
  {
    description:
      "Convert HTML/CSS (optionally Tailwind) into native Figma layers. flex → Auto Layout; CSS grid → native GRID auto layout (tracks fr/px/auto, gaps, spans); text runs with links, line-clamp/ellipsis truncation; gradients; borders/outlines; radii; shadows; blur/backdrop-blur; mix-blend-mode/background-blend-mode; transforms (rotate/scale/translate); clip-path basic shapes → masks; ::before/::after and list markers → real layers; images (object-fit, background-repeat tiling, CSS colour filters baked in); inline SVG. " +
      "Attributes: data-figma-name=\"Layer\", data-figma-component=\"Card\" (elements with the same value become one main component + instances with text/image overrides), data-figma-effects='[…raw Figma effects…]' (e.g. GLASS, NOISE, TEXTURE, progressive blur), data-figma-skip. " +
      "bindVariables:true binds colours/spacing/radii/font sizes to matching local variables and text styles. Returns root id, warnings for everything approximated or dropped, and a screenshot.",
    inputSchema: {
      html: z.string().describe("HTML markup for ONE root element (or a fragment; it is wrapped in a frame)."),
      css: z.string().optional().describe("Extra CSS."),
      tailwind: z.boolean().optional().describe("Load the Tailwind Play CDN (needs internet). Default: auto-detect from class names."),
      width: z.number().positive().optional().describe("Viewport width in px (default 1440)."),
      viewportHeight: z.number().positive().optional().describe("Viewport height in px (default 900) — what vh / min-h-screen resolve to."),
      x: z.number().optional(),
      y: z.number().optional(),
      parentId: z.string().optional().describe("Node id to insert into (frame/page/section). Default: current page."),
      name: z.string().optional(),
      bindVariables: z.boolean().optional().describe("Bind raw values to matching local variables / text styles after building."),
      pseudo: z.boolean().optional().describe("Convert ::before/::after and list markers into layers (default true)."),
      keepAnimations: z.boolean().optional().describe("Keep CSS animations/transitions running while measuring (default false = resting state)."),
      screenshot: z.boolean().optional().describe("Default true."),
    },
  },
  (args, extra) => run(async () => withImages(await bridge.call("render_html", args, 120_000, progressOf(extra))))
);

server.registerTool(
  "insert_asset",
  {
    description:
      "Insert an asset. kind='svg' (markup or `path` to a .svg), 'icon' (Iconify id like 'lucide:home', fetched by the server), 'image' (`url`, local `path` or `base64`; png/jpg/gif/webp/avif/svg; >4096 px is downscaled; optional CSS `filter` baked in), " +
      "'video' (`path`/`url`/`base64` mp4/mov/webm → native video fill). targetNodeId applies the image/video as a fill of an existing node.",
    inputSchema: {
      kind: z.enum(["svg", "icon", "image", "video"]),
      svg: z.string().optional(),
      icon: z.string().optional().describe("Iconify id, e.g. 'lucide:arrow-right', 'mdi:account'."),
      size: z.number().positive().optional().describe("Icon size in px (default 24)."),
      color: z.string().optional().describe("Icon color, e.g. '#ffffff' (default currentColor → black)."),
      url: z.string().url().optional(),
      path: z.string().optional().describe("Local file path."),
      base64: z.string().optional(),
      filter: z.string().optional().describe("CSS filter for images, e.g. 'grayscale(1) contrast(1.2)'."),
      scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      name: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      parentId: z.string().optional(),
      targetNodeId: z.string().optional().describe("Apply as a fill of this existing node instead of creating a rectangle."),
    },
  },
  (a) =>
    run(async () => {
      const params: any = { ...a };
      if (a.kind === "icon") {
        if (!a.icon || !a.icon.includes(":")) throw new Error("icon must look like 'set:name'");
        const [set, name] = a.icon.split(":");
        const size = a.size ?? 24;
        const color = a.color ? `&color=${encodeURIComponent(a.color)}` : "";
        const res = await fetch(`https://api.iconify.design/${set}/${name}.svg?height=${size}${color}`);
        if (!res.ok) throw new Error(`Iconify returned ${res.status} for ${a.icon}`);
        params.kind = "svg";
        params.svg = await res.text();
        params.name = a.name ?? a.icon;
      } else if (a.kind === "svg" && !a.svg && a.path) {
        params.svg = (await loadBinary(a.path)).toString("utf8");
      } else if ((a.kind === "image" || a.kind === "video") && !a.base64) {
        const src = a.url ?? a.path;
        if (!src) throw new Error("Pass url, path or base64");
        params.base64 = (await loadBinary(src)).toString("base64");
      }
      delete params.path;
      delete params.url;
      return withImages(await bridge.call("insert_asset", params, 120_000));
    })
);

server.registerTool(
  "render_shader",
  {
    description:
      "Render a GLSL fragment shader (WebGL) to a PNG inside the plugin UI and place it on the canvas as an image fill. " +
      "Write a complete fragment shader (GLSL ES 1.00): `precision highp float; uniform vec2 u_resolution; uniform float u_time; void main(){ vec2 uv = gl_FragCoord.xy/u_resolution; gl_FragColor = vec4(uv,0.5,1.0); }`. " +
      "Good for noise, gradient meshes, grain, aurora backgrounds. The result is a raster image.",
    inputSchema: {
      fragment: z.string(),
      width: z.number().int().min(1).max(4096),
      height: z.number().int().min(1).max(4096),
      time: z.number().optional().describe("Value for u_time (default 0)."),
      targetNodeId: z.string().optional().describe("Apply as image fill to this node; otherwise a new rectangle is created."),
      name: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      parentId: z.string().optional(),
    },
  },
  (a) => run(async () => withImages(await bridge.call("render_shader", a, 60_000)))
);

// ───────────────────────── prototyping & motion ─────────────────────────

const easingSchema = z
  .union([
    z.enum([
      "LINEAR", "EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "EASE_IN_BACK", "EASE_OUT_BACK", "EASE_IN_AND_OUT_BACK",
      "GENTLE", "QUICK", "BOUNCY", "SLOW",
    ]),
    z.object({ bezier: z.tuple([z.number(), z.number(), z.number(), z.number()]) }),
    z.object({ spring: z.object({ mass: z.number().optional(), stiffness: z.number().optional(), damping: z.number().optional() }) }),
  ])
  .describe("Preset name, {bezier:[x1,y1,x2,y2]} or {spring:{mass,stiffness,damping}}. Default EASE_OUT.");

server.registerTool(
  "prototype",
  {
    description:
      "Prototyping: wire interactions between frames/components/variants. " +
      "op='link' adds a reaction on `from` (trigger → action → `to`) with an animated transition (SMART_ANIMATE animates matching layers by name, ideal for micro-interactions and variant hover/press states). " +
      "op='list' shows existing interactions + flows, 'clear' removes a node's interactions, 'flow' adds/removes a flow starting point (merges with existing flows). " +
      "For timeline animation (keyframes, presets, video export) use `motion`.",
    inputSchema: {
      op: z.enum(["link", "list", "clear", "flow"]),
      from: z.string().optional().describe("Source node id (the element that gets the interaction). For 'list': optional subtree root. For 'flow': the starting frame."),
      to: z.string().optional().describe("Destination node id (frame, overlay, or variant component for change_to)."),
      trigger: z
        .enum(["ON_CLICK", "ON_HOVER", "ON_PRESS", "AFTER_TIMEOUT", "MOUSE_ENTER", "MOUSE_LEAVE", "MOUSE_UP", "MOUSE_DOWN", "ON_KEY_DOWN"])
        .optional()
        .describe("Default ON_CLICK."),
      triggerOptions: z
        .object({ timeout: z.number().optional().describe("seconds (AFTER_TIMEOUT)"), delay: z.number().optional().describe("ms (MOUSE_*)"), keyCodes: z.array(z.number()).optional(), device: z.string().optional() })
        .optional(),
      action: z.enum(["navigate", "overlay", "swap", "change_to", "scroll_to", "back", "close", "url"]).optional().describe("Default navigate. change_to = switch a component instance to another variant."),
      url: z.string().optional(),
      openInNewTab: z.boolean().optional(),
      transition: z
        .object({
          type: z.enum(["SMART_ANIMATE", "DISSOLVE", "MOVE_IN", "MOVE_OUT", "PUSH", "SLIDE_IN", "SLIDE_OUT", "SCROLL_ANIMATE", "INSTANT"]).optional(),
          direction: z.enum(["LEFT", "RIGHT", "TOP", "BOTTOM"]).optional().describe("For MOVE_IN/MOVE_OUT/PUSH/SLIDE_IN/SLIDE_OUT."),
          duration: z.number().optional().describe("seconds, default 0.3"),
          easing: easingSchema.optional(),
          matchLayers: z.boolean().optional(),
        })
        .optional(),
      append: z.boolean().optional().describe("Keep the node's other reactions (default true). A new reaction replaces an existing one with the same trigger."),
      remove: z.boolean().optional().describe("op='flow': remove instead of add."),
      name: z.string().optional().describe("op='flow': flow name."),
    },
  },
  (a) => run(async () => [json(await bridge.call("prototype", a))])
);

const keySchema = z.union([
  z.tuple([z.number(), z.any()]),
  z.tuple([z.number(), z.any(), z.any()]),
  z.object({ t: z.number(), v: z.any(), easing: z.any().optional() }),
]);

server.registerTool(
  "motion",
  {
    description:
      "Figma's NATIVE motion timeline (keyframe animation stored in the file, played in Figma and exportable as MP4/GIF/WEBM via `export`). " +
      "op='styles' lists Figma's animation presets (TextStagger, Position, Scale, Rotation, Size, Opacity, Path) with their props; " +
      "'apply' adds a preset to `nodeId` (or a child via `target` name): {style:'Opacity', props:{duration:0.5}, options:{timelineOffset:0.2}}; " +
      "'animate' writes keyframe tracks: tracks:[{target?:'Layer name', prop:'opacity'|'x'|'y'|'xy'|'rotation'|'scale'|'scaleX'|'width'|'height'|'radius'|'gap'|'strokeWeight'|'trimStart'|'trimEnd'|'effects[0].RADIUS'|…, keys:[[t,v,easing?],…]}] — t in seconds, v number / '#hex' / {x,y} / bool; x/y/rotation/scale are offsets from the static layout; the timeline is extended to the last key; " +
      "'timeline' sets duration/playback {autoplay,loop,muted}; 'remove' (styleId or prop), 'clear' (subtree), 'read' (all tracks/styles in a subtree). " +
      "Timelines belong to top-level frames: animate layers inside one frame and export that frame.",
    inputSchema: {
      op: z.enum(["styles", "apply", "animate", "timeline", "remove", "clear", "read"]),
      nodeId: z.string().optional().describe("Frame (or layer) to work on; default: selection."),
      target: z.string().optional().describe("Child layer name or id (apply/remove)."),
      style: z.string().optional().describe("op='apply': preset styleId, e.g. 'Opacity', 'Position', 'TextStagger'."),
      props: z.record(z.string(), z.any()).optional(),
      options: z.record(z.string(), z.any()).optional().describe("e.g. {timelineOffset: seconds}."),
      tracks: z
        .array(z.object({ target: z.string().optional(), prop: z.union([z.string(), z.record(z.string(), z.any())]), keys: z.array(keySchema) }))
        .optional(),
      duration: z.number().positive().optional().describe("Timeline duration in seconds."),
      playback: z.object({ autoplay: z.boolean().optional(), loop: z.boolean().optional(), muted: z.boolean().optional() }).optional(),
      styleId: z.string().optional(),
      prop: z.string().optional(),
      subtree: z.boolean().optional(),
    },
  },
  (a) => run(async () => [json(await bridge.call("motion", a))])
);

async function encodeVideo(dir: string, format: "mp4" | "webm" | "gif", fps: number) {
  const bin = (await findFfmpeg())!;
  const file = join(dir, `animation.${format}`);
  const t0 = Date.now();
  const r = await ffmpegRun(bin, ffmpegArgs(format, fps, join(dir, "frame_%04d.png"), file));
  if (r.code !== 0) throw new Error("ffmpeg failed: " + r.stderr.slice(-600));
  return { file, encodeMs: Date.now() - t0, kb: Math.round((await stat(file)).size / 1024) };
}

server.registerTool(
  "capture_animation",
  {
    description:
      "Render an animation OFFLINE, frame by frame, to PNGs + mp4/webm/gif (ffmpeg). Three sources, combinable: " +
      "(1) `tracks` — declarative keyframes: [{target?:'Layer name'|id, prop, keys:[[t,v,easing?],…]} or {prop, from, to, start?, end?, easing}] with props x, y, translateX, translateY, rotate (deg clockwise, around centre), scale, scaleX, scaleY, opacity, width, height, radius, fill/stroke ('#hex'), blur, or any numeric property path like 'itemSpacing' / 'effects[0].radius'; easings: linear, ease, easeIn/Out/InOut, easeIn/Out/InOut{Quad,Cubic,Quart,Expo}, easeInBack, easeOutBack, easeOutElastic, easeOutBounce, [x1,y1,x2,y2], {spring:{mass,stiffness,damping}}, Figma names (EASE_OUT, GENTLE, BOUNCY…). " +
      "(2) `timeline: true` — evaluates the node's native Figma keyframe tracks (see `motion`; presets need native `export` instead). " +
      "(3) `code` — per-frame JS with figma, node, i, t (0..1), n, h, sec. " +
      "Times are seconds when `duration` is set (or timeline:true), else 0..1. Auto-layout children are floated with a placeholder so siblings do not move. Everything is rolled back afterwards (one undo step). placeVideo:true puts the result back into Figma as a video fill.",
    inputSchema: {
      nodeId: z.string().describe("Frame/group/component to capture."),
      tracks: z.array(z.record(z.string(), z.any())).optional(),
      timeline: z.boolean().optional(),
      code: z.string().optional().describe("Per-frame state code, e.g. `const ball=h.find(node,'Ball'); ball.x=60+t*600;`"),
      duration: z.number().positive().optional().describe("Seconds. frames = duration × fps when `frames` is omitted."),
      frames: z.number().int().min(1).max(1800).optional(),
      fps: z.number().int().min(1).max(60).optional().describe("Default 30."),
      scale: z.number().min(0.25).max(4).optional().describe("Export scale, default 1."),
      format: z.enum(["mp4", "webm", "gif", "frames"]).optional().describe("Default mp4. 'frames' = PNG sequence only."),
      outDir: z.string().optional().describe("Output directory (default ./figma-captures/<timestamp>)."),
      restore: z.boolean().optional().describe("Roll back the node changes afterwards (default true)."),
      placeVideo: z.boolean().optional().describe("Insert the encoded mp4/webm into Figma next to the node."),
    },
  },
  (a, extra) =>
    run(async () => {
      const fps = a.fps ?? 30;
      const format = a.format ?? "mp4";
      const res = await bridge.call(
        "capture",
        { nodeId: a.nodeId, code: a.code, tracks: a.tracks, timeline: a.timeline, duration: a.duration, frames: a.frames, fps, scale: a.scale ?? 1, restore: a.restore },
        120_000,
        progressOf(extra)
      );
      const dir = resolve(a.outDir ?? join(process.cwd(), "figma-captures", stamp()));
      await mkdir(dir, { recursive: true });
      const frames: { base64: string }[] = res.frames;
      await Promise.all(frames.map((f, i) => writeFile(join(dir, `frame_${String(i + 1).padStart(4, "0")}.png`), Buffer.from(f.base64, "base64"))));
      const out: any = { dir, frames: frames.length, width: res.width, height: res.height, renderMs: res.renderMs, msPerFrame: Math.round(res.renderMs / frames.length), fps, seconds: +(frames.length / fps).toFixed(2) };
      if (res.warnings?.length) out.warnings = res.warnings;
      if (format !== "frames") {
        const v = await encodeVideo(dir, format, fps);
        Object.assign(out, { video: v.file, encodeMs: v.encodeMs, videoKB: v.kb });
        if (a.placeVideo && format !== "gif") {
          const placed = await bridge.call("insert_asset", { kind: "video", base64: (await readFile(v.file)).toString("base64"), width: res.width / (a.scale ?? 1), height: res.height / (a.scale ?? 1), name: "Animation" }, 120_000);
          out.placedVideo = placed.nodeId;
        }
      }
      const content: Content[] = [json(out)];
      for (const idx of [...new Set([0, Math.floor(frames.length / 2), frames.length - 1])]) {
        content.push(text(`frame ${idx + 1}/${frames.length}`));
        content.push(image(frames[idx].base64));
      }
      return content;
    })
);

// ───────────────────────── export / code ─────────────────────────

const EXT: Record<string, string> = { PNG: "png", JPG: "jpg", SVG: "svg", SVG_STRING: "svg", PDF: "pdf", JSON_REST_V1: "json", MP4: "mp4", GIF: "gif", WEBM: "webm" };

server.registerTool(
  "export",
  {
    description:
      "Export nodes to files on disk: PNG/JPG (scale or exact width/height, up to ~8000 px), SVG (outline text / id attributes / simplify stroke), PDF, JSON_REST_V1 (the REST-API JSON of the node), " +
      "and NATIVE timeline video MP4/GIF/WEBM (frames animated with `motion`; fps 12/24/30/60, quality LOW/MEDIUM/HIGH; needs the Figma window in the foreground). Returns the file paths (+ a preview of raster images).",
    inputSchema: {
      nodeIds: z.array(z.string()).optional(),
      nodeId: z.string().optional(),
      format: z.enum(["PNG", "JPG", "SVG", "PDF", "JSON_REST_V1", "MP4", "GIF", "WEBM"]).optional().describe("Default PNG."),
      scale: z.number().min(0.01).max(8).optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      fps: z.number().optional(),
      quality: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
      svgOutlineText: z.boolean().optional(),
      svgIdAttribute: z.boolean().optional(),
      svgSimplifyStroke: z.boolean().optional(),
      contentsOnly: z.boolean().optional(),
      useAbsoluteBounds: z.boolean().optional(),
      outDir: z.string().optional().describe("Default ./figma-exports/<timestamp>."),
      preview: z.boolean().optional().describe("Return raster exports inline as images too (default true, max 3)."),
    },
  },
  (a, extra) =>
    run(async () => {
      const { outDir, preview, ...params } = a;
      const res = await bridge.call("export", params, 300_000, progressOf(extra));
      const dir = resolve(outDir ?? join(process.cwd(), "figma-exports", stamp()));
      await mkdir(dir, { recursive: true });
      const used = new Set<string>();
      const files: any[] = [];
      const content: Content[] = [];
      for (const f of res.files) {
        let base = safeName(f.name);
        while (used.has(base)) base += "_";
        used.add(base);
        const path = join(dir, `${base}.${EXT[f.format] ?? "bin"}`);
        if (f.json !== undefined) await writeFile(path, JSON.stringify(f.json, null, 2));
        else if (f.text !== undefined) await writeFile(path, f.text);
        else await writeFile(path, Buffer.from(f.base64, "base64"));
        const size = (await stat(path)).size;
        files.push({ nodeId: f.nodeId, name: f.name, path, kb: Math.round(size / 1024), ms: f.ms });
        if (preview !== false && (f.format === "PNG" || f.format === "JPG") && f.base64 && content.length < 6 && f.base64.length < 2_000_000) {
          content.push(text(`${f.name} → ${path}`));
          content.push(image(f.base64, f.format === "JPG" ? "image/jpeg" : "image/png"));
        }
      }
      return [json({ dir, files }), ...content];
    })
);

server.registerTool(
  "to_code",
  {
    description:
      "Figma → code. Converts a node tree to HTML+CSS (or a React JSX component + CSS) using Figma's own CSS generator per layer: Auto Layout → flexbox, GRID → CSS grid, absolute positions, effects, text runs with links, vectors/icons → inline SVG, image fills → files or data URIs. " +
      "With outDir the files (index.html or Component.jsx + Component.css + assets/) are written to disk. Pair with `compare` to measure round-trip fidelity.",
    inputSchema: {
      nodeId: z.string().optional().describe("Default: selection."),
      format: z.enum(["html", "jsx"]).optional(),
      images: z.enum(["inline", "files", "none"]).optional().describe("Default: 'files' with outDir, else 'none'."),
      outDir: z.string().optional(),
    },
  },
  (a, extra) =>
    run(async () => {
      const images = a.images ?? (a.outDir ? "files" : "none");
      const res = await bridge.call("to_code", { nodeId: a.nodeId, format: a.format ?? "html", images }, 300_000, progressOf(extra));
      const out: any = { nodes: res.nodes, warnings: res.warnings };
      const main = res.html ?? res.jsx;
      if (a.outDir) {
        const dir = resolve(a.outDir);
        await mkdir(join(dir, "assets"), { recursive: true });
        if (res.html) await writeFile((out.file = join(dir, "index.html")), res.html);
        else {
          await writeFile((out.file = join(dir, `${res.component}.jsx`)), res.jsx);
          await writeFile((out.css = join(dir, `${res.component}.css`)), res.css);
        }
        for (const asset of res.assets ?? []) await writeFile(join(dir, asset.path), Buffer.from(asset.base64, "base64"));
        out.assets = (res.assets ?? []).length;
      }
      if (a.outDir) return [json(out)]; // the code is on disk: keep it out of the context
      const limit = 40_000;
      const content: Content[] = [json(out)];
      content.push(text(main.length > limit ? main.slice(0, limit) + `\n… (${main.length - limit} more chars${a.outDir ? ", see file" : "; pass outDir to get the full file"})` : main));
      if (res.css && !a.outDir) content.push(text(res.css.length > limit ? res.css.slice(0, limit) + "\n…" : res.css));
      return content;
    })
);

server.registerTool(
  "compare",
  {
    description:
      "Perceptual visual diff of candidate `a` against reference `b` (node id, local PNG/JPG path, URL or base64). Measures CIEDE2000 colour difference and SSIM, then returns a PASS/FAIL verdict against explicit tolerances, " +
      "a ΔE heat-map grid, the worst cells with coordinates, both average colours and a plain-language hint (e.g. 'a is darker, less saturated than b'), and a diff image. " +
      "Pick `preset` strict | normal (default) | loose, or override the individual limits. Iterate until verdict is PASS. Coordinates are in a's units, relative to a's top-left. Use `region` to check one part, `fit` when aspect ratios differ.",
    inputSchema: {
      a: z.string().describe("Candidate: node id."),
      b: z.string().describe("Reference: node id, file path, URL or base64."),
      scale: z.number().min(0.1).max(2).optional().describe("Export scale for node sides (default 1)."),
      preset: z.enum(["strict", "normal", "loose"]).optional().describe("Tolerance preset: strict (ΔE 2.3, ≤0.5% pixels, SSIM ≥ 0.98), normal (ΔE 5, ≤2%, SSIM ≥ 0.95), loose (ΔE 10, ≤8%, SSIM ≥ 0.85)."),
      tolerance: z.number().min(0).max(100).optional().describe("Per-pixel ΔE2000 above which a pixel counts as different (≈2.3 is barely visible, 5 is visible at a glance)."),
      maxMismatch: z.number().min(0).max(1).optional().describe("Maximum allowed share of different pixels (0–1)."),
      maxMeanDeltaE: z.number().min(0).max(100).optional().describe("Maximum allowed mean ΔE over the image."),
      minSsim: z.number().min(0).max(1).optional().describe("Minimum required structural similarity (0–1)."),
      fit: z.enum(["stretch", "contain", "cover"]).optional().describe("How b is fitted into a's frame (default stretch; the result flags aspectMismatch)."),
      region: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional().describe("Compare only this rectangle of a (a's units, relative to its top-left)."),
      grid: z.number().int().min(2).max(24).optional().describe("Cells per side for heatmap/hotspots (default 8)."),
      background: z.string().optional().describe("Colour that transparent pixels are composited on (default #ffffff)."),
      images: z.enum(["diff", "all", "none"]).optional().describe("Returned image: diff heat-map (default), `all` = a | b | diff side by side, or none."),
    },
  },
  (a) =>
    run(async () => {
      const side = async (s: string) =>
        NODE_ID.test(s) ? { nodeId: s, scale: a.scale ?? 1 } : { base64: (await loadBinary(s)).toString("base64") };
      const { a: sa, b: sb, scale: _scale, ...opts } = a;
      return withImages(await bridge.call("compare", { ...opts, a: await side(sa), b: await side(sb) }, 120_000));
    })
);

// ───────────────────────── libraries / REST ─────────────────────────

server.registerTool(
  "library",
  {
    description:
      "Team libraries enabled in this file and collaborators. op='collections' lists library variable collections, 'variables' lists variables of one (key), 'import_variable' imports by key, " +
      "'import_component' / 'import_component_set' imports by key (and places an instance unless instance:false), 'import_style' imports a style by key, 'users' shows the current user and active collaborators. " +
      "Library component keys come from `read` of instances, from figma_rest (team components), or from the user.",
    inputSchema: {
      op: z.enum(["collections", "variables", "import_variable", "import_component", "import_component_set", "import_style", "users"]),
      key: z.string().optional(),
      instance: z.boolean().optional(),
      parentId: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    },
  },
  (a) => run(async () => [json(await bridge.call("library", a))])
);

server.registerTool(
  "figma_rest",
  {
    description:
      "Call the Figma REST API with the token in the FIGMA_TOKEN environment variable. Unlocks what the Plugin API cannot do: comments (GET/POST /v1/files/:key/comments), version list (/v1/files/:key/versions), " +
      "team library components/styles (/v1/teams/:team_id/components, /v1/files/:key/components), rendered images (/v1/images/:key?ids=…), dev resources, webhooks. " +
      "The file key is the part after /design/ (or /file/) in the file URL — ask the user for the URL.",
    inputSchema: {
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional(),
      path: z.string().describe("e.g. /v1/files/ABC123/comments"),
      body: z.any().optional(),
    },
  },
  (a) =>
    run(async () => {
      const token = process.env.FIGMA_TOKEN;
      if (!token) throw new Error("Set FIGMA_TOKEN (a personal access token from Figma → Settings → Security) in the MCP server environment.");
      const res = await fetch("https://api.figma.com" + (a.path.startsWith("/") ? a.path : "/" + a.path), {
        method: a.method ?? "GET",
        headers: { "X-Figma-Token": token, ...(a.body ? { "Content-Type": "application/json" } : {}) },
        body: a.body ? JSON.stringify(a.body) : undefined,
      });
      const body = await res.text();
      const short = body.length > 100_000 ? body.slice(0, 100_000) + "\n… (truncated)" : body;
      if (!res.ok) throw new Error(`Figma REST ${res.status}: ${short.slice(0, 2000)}`);
      return [text(short)];
    })
);

// ───────────────────────── skills ─────────────────────────

server.registerTool(
  "skills",
  {
    description:
      "Short playbooks. Call without arguments to list, with `name` to read one. `core` = workflow + API pitfalls (read first). `design-taste` = quality defaults, `motion-principles` = animation craft; others: layout, components, variables-tokens, effects-glass, prototyping, shaders. Read only what the task needs.",
    inputSchema: { name: z.string().optional() },
  },
  ({ name }) =>
    run(async () => {
      const skills = loadSkills();
      if (!name) return [text(skills.map((s) => `- ${s.name}: ${s.title}`).join("\n") || "No skills found.")];
      const s = skills.find((x) => x.name === name);
      if (!s) throw new Error(`Unknown skill '${name}'. Available: ${skills.map((x) => x.name).join(", ")}`);
      return [text(s.body)];
    })
);


await server.connect(new StdioServerTransport());
console.error(`[figma-canvas-mcp] MCP ready (v${VERSION}); WebSocket on ws://127.0.0.1:${PORT}`);
