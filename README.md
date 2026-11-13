# Figma Canvas MCP

An MCP server and a Figma plugin that let an AI agent edit the open Figma file through the Plugin API.

Instead of dozens of small tools like `create_rect` and `set_fill`, the agent gets a few large ones: it can send a whole screen as HTML, or run arbitrary Plugin API code in one call. It works with any MCP client (Claude Code, Cursor, Windsurf, Claude Desktop, OpenCode). Nothing is sent to Figma's servers, and no paid seat is required.

## How it works

```
MCP client ──stdio──▶ server (Node.js) ──WebSocket 127.0.0.1:3055──▶ Figma plugin ──▶ open file
```

The server translates MCP tool calls into messages for the plugin. The plugin runs in the Figma desktop app, executes them against the document and returns the result (and, where useful, a screenshot).

## Install

Requires Node.js 18 or newer and the Figma desktop app.

**1. Register the server in your MCP client.**

Claude Code:

```bash
claude mcp add figma-canvas-mcp -- npx -y figma-canvas-mcp
```

Other clients (`mcp.json`):

```json
{
  "mcpServers": {
    "figma-canvas": {
      "command": "npx",
      "args": ["-y", "figma-canvas-mcp"]
    }
  }
}
```

OpenCode uses its own format:

```json
{
  "mcp": {
    "figma-canvas": {
      "type": "local",
      "command": ["npx", "-y", "figma-canvas-mcp"]
    }
  }
}
```

**2. Load the plugin once.** Clone this repository, then in Figma choose *Plugins → Development → Import plugin from manifest…* and select `plugin/manifest.json`.

**3. Run it.** Open a file, start *Plugins → Development → Figma Canvas MCP* and keep the small window open. The agent can now call `status` to check the connection.

## Tools

| Tool | What it does |
| :--- | :--- |
| `render_html` | Converts HTML/CSS/Tailwind into native frames. Flexbox becomes Auto Layout, CSS Grid becomes Figma's `GRID` layout. `data-figma-component` creates components and instances. |
| `execute` | Runs JavaScript inside the plugin with full `figma.*` access. Input goes through `args`; helpers are in `h`. If the code throws, its changes are rolled back. |
| `history` | Undo by steps, with a guard so the agent does not undo your own edits. Can also save a named version. |
| `read` | Compact JSON view of the selection, a node, a page or the whole file. |
| `screenshot` | PNG of a node or the selection. |
| `compare` | Pixel diff of a node against another node, a PNG file or a URL. Returns the mismatch ratio and a diff image. |
| `to_code` | Exports nodes as HTML/CSS or React JSX. |
| `export` | Exports nodes to disk as PNG, SVG, PDF, JSON, or video. |
| `motion` | Works with Figma's native motion timeline: keyframes, durations, presets. |
| `capture_animation` | Renders an animation frame by frame and encodes MP4, GIF or WebM with ffmpeg. |
| `prototype` | Sets up flows, interactions, Smart Animate and overlays. |
| `insert_asset` | Places SVGs, Iconify icons, images and video fills. |
| `render_shader` | Renders a GLSL fragment shader in offscreen WebGL and applies it as an image fill. |
| `library` | Finds and imports components, styles and variables from team libraries. |
| `page` | Lists, switches and creates pages. |
| `figma_rest` | Calls the Figma REST API with `FIGMA_TOKEN` (comments, version list and other things the Plugin API cannot reach). |
| `skills` | Built-in design guidance the agent can load on demand (`core`, `layout`, `components`, `motion-principles`, and others). |
| `status` | Connection check, current file, switching between open files. |

## Configuration

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `FIGMA_MCP_PORT` | `3055` | Port of the local WebSocket relay. |
| `FIGMA_MCP_IMAGES` | on | Set to `0` to stop returning images (for clients without image input). |
| `FIGMA_TOKEN` | unset | Personal access token, needed only for `figma_rest`. |
| `FFMPEG_PATH` | bundled | Use your own ffmpeg instead of `ffmpeg-static`. |

## Security

The relay listens on loopback only (`127.0.0.1` and `::1`) and rejects connections that carry a browser `Origin`; only the plugin sandbox, whose origin is `null`, is accepted. `execute` runs arbitrary code in the Figma plugin sandbox, so connect only MCP clients you trust.

The plugin manifest allows network access to any domain because `render_html` has to load images, fonts and stylesheets referenced by the HTML it receives.

## Known limits

- The plugin window must stay open; without it every tool fails.
- Undo shares Figma's stack with you. The guard in `history` reduces the risk but cannot remove it.
- Prototype playback cannot be recorded through the API, so `capture_animation` interpolates the motion itself.

Measurements and details of what was tested against a live file are in [docs/research.md](docs/research.md).

## Development

```bash
cd server
npm install
npm run build
```

The plugin in `plugin/` is plain JavaScript and needs no build step; reload it in Figma after changes. Skill files in `server/skills/` are Markdown.

```
plugin/   Figma plugin (code.js main thread, ui.html relay and DOM parser)
server/   MCP server (src/) and built-in skills (skills/)
docs/     Research notes
assets/   Plugin icons and logo
```

## License

[MIT](LICENSE)
