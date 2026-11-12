import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

export type Progress = (p: { done: number; total: number; note?: string }) => void;

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  conn: number;
  onProgress?: Progress;
  timeoutMs: number;
  method: string;
};

export interface PluginInfo {
  fileName?: string;
  pageName?: string;
  [k: string]: unknown;
}

type Conn = { id: number; ws: WebSocket; info: PluginInfo | null; since: number; alive: boolean };

/**
 * WebSocket relay between the MCP server and Figma plugin instances (one per open file).
 * The server is the WS server; plugins connect to it. Calls go to the active connection
 * (the most recent one, or the one chosen with use()).
 */
export class Bridge {
  private wss?: WebSocketServer;
  private conns = new Map<number, Conn>();
  private active?: number;
  private pinned = false;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private nextConn = 1;
  public listenError: string | null = null;

  constructor(private port: number) {}

  start(): Promise<void> {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 * 1024 });
    wss.on("connection", (ws) => this.onConnection(ws));
    this.wss = wss;

    // keepalive: detect dead plugin windows (closed tab, sleeping laptop) quickly
    setInterval(() => {
      for (const c of this.conns.values()) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        try {
          c.ws.ping();
        } catch {
          /* closed */
        }
      }
    }, 20_000).unref();

    // The plugin connects to ws://localhost:<port>, which may resolve to IPv4 or IPv6 loopback: listen on both.
    const listen = (host: string) =>
      new Promise<boolean>((resolve) => {
        const srv = createServer((_req, res) => {
          res.writeHead(426);
          res.end("figma-canvas-mcp: WebSocket only");
        });
        srv.on("upgrade", (req, socket, head) => {
          // Figma plugin iframes report the origin "null". Reject real web origins so
          // a random web page cannot impersonate the plugin.
          const origin = req.headers.origin;
          if (origin && origin !== "null") {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
        });
        srv.on("error", (err: NodeJS.ErrnoException) => {
          if (host === "127.0.0.1") {
            this.listenError =
              err.code === "EADDRINUSE"
                ? `Port ${this.port} is already in use (another figma-canvas-mcp instance?). Set FIGMA_MCP_PORT to a free port in both the MCP config and the plugin UI.`
                : String(err.message);
            console.error("[figma-canvas-mcp] " + this.listenError);
          } // IPv6 loopback may be unavailable: ignore
          resolve(false);
        });
        srv.listen(this.port, host, () => resolve(true));
      });

    return listen("127.0.0.1").then((ok) => (ok ? listen("::1").then(() => undefined) : undefined));
  }

  get connected(): boolean {
    const c = this.current();
    return !!c && c.ws.readyState === WebSocket.OPEN;
  }

  get info(): PluginInfo | null {
    return this.current()?.info ?? null;
  }

  private current(): Conn | undefined {
    return this.active !== undefined ? this.conns.get(this.active) : undefined;
  }

  /** All connected plugin instances (one per open Figma file/tab). */
  list() {
    return [...this.conns.values()].map((c) => ({
      id: c.id,
      file: c.info?.fileName ?? "?",
      page: c.info?.pageName ?? "?",
      active: c.id === this.active,
      connectedSec: Math.round((Date.now() - c.since) / 1000),
    }));
  }

  /** Choose the target connection by id or (partial, case-insensitive) file name. */
  use(selector: string | number): Conn {
    const all = [...this.conns.values()];
    const s = String(selector).toLowerCase();
    const hit = all.find((c) => String(c.id) === s) ?? all.find((c) => (c.info?.fileName ?? "").toLowerCase() === s) ?? all.find((c) => (c.info?.fileName ?? "").toLowerCase().includes(s));
    if (!hit) throw new Error(`No connected Figma file matches '${selector}'. Connected: ${all.map((c) => `${c.id}: ${c.info?.fileName}`).join(", ") || "none"}`);
    this.active = hit.id;
    this.pinned = true;
    return hit;
  }

  private onConnection(ws: WebSocket) {
    const conn: Conn = { id: this.nextConn++, ws, info: null, since: Date.now(), alive: true };
    this.conns.set(conn.id, conn);
    if (!this.pinned || !this.current()) this.active = conn.id; // latest connection wins unless the agent chose one
    console.error(`[figma-canvas-mcp] plugin connected (#${conn.id})`);
    ws.on("pong", () => (conn.alive = true));
    ws.on("message", (raw) => {
      conn.alive = true;
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "hello") {
        conn.info = msg.info ?? {};
        return;
      }
      if (typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (!p) return;
        if (msg.progress) {
          // progress also extends the deadline: long renders stay alive while they report
          clearTimeout(p.timer);
          p.timer = setTimeout(() => this.expire(msg.id), p.timeoutMs);
          p.onProgress?.(msg.progress);
          return;
        }
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      }
    });
    ws.on("close", () => {
      this.conns.delete(conn.id);
      console.error(`[figma-canvas-mcp] plugin disconnected (#${conn.id})`);
      if (this.active === conn.id) {
        const rest = [...this.conns.keys()];
        this.active = rest.length ? rest[rest.length - 1] : undefined;
        this.pinned = false;
      }
      for (const [id, p] of this.pending) {
        if (p.conn !== conn.id) continue;
        clearTimeout(p.timer);
        p.reject(new Error("Figma plugin disconnected"));
        this.pending.delete(id);
      }
    });
  }

  private expire(id: number) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.reject(new Error(`Timed out after ${p.timeoutMs}ms without a reply or progress from Figma (${p.method})`));
  }

  call(method: string, params: unknown = {}, timeoutMs = 60_000, onProgress?: Progress): Promise<any> {
    if (this.listenError) return Promise.reject(new Error(this.listenError));
    const conn = this.current();
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error(
          "Figma plugin is not connected. In Figma: Plugins → Development → Figma Canvas MCP (open the file you want to edit and keep the plugin window open)."
        )
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.expire(id), timeoutMs);
      this.pending.set(id, { resolve, reject, timer, conn: conn.id, onProgress, timeoutMs, method });
      conn.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
