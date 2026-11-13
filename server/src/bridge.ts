import { createServer, type Server } from "node:http";
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
/** One agent's view of the hub: which plugin connection its calls go to. */
type Session = { active?: number; pinned: boolean };
type Remote = { ws: WebSocket; alive: boolean; session: Session };
type ClientPending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; onProgress?: Progress; timeoutMs: number; method: string };

export interface BridgeState {
  connected: boolean;
  info: PluginInfo | null;
  connections: { id: number; file: string; page: string; active: boolean; connectedSec: number }[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * WebSocket relay between MCP servers (agents) and Figma plugin instances (one per open file).
 *
 * Several agent sessions can run at once, each as its own MCP process. The first process to bind the port
 * becomes the HUB: it accepts the plugin connections and also agent connections on `/hub`. Every later
 * process finds the port taken and becomes a CLIENT that forwards its calls through the hub. Each agent
 * has its own target file (`use`); calls from different agents are interleaved on the plugin side.
 * If the hub process exits, one of the clients takes over the port and the plugin reconnects by itself.
 */
export class Bridge {
  private wss?: WebSocketServer;
  private hubWss?: WebSocketServer;
  private servers: Server[] = [];
  private conns = new Map<number, Conn>();
  private remotes = new Set<Remote>();
  private local: Session = { pinned: false };
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private nextConn = 1;

  private client?: WebSocket;
  private clientPending = new Map<number, ClientPending>();
  private nextClientId = 1;
  private ready: Promise<void> = Promise.resolve();

  public role: "hub" | "client" | "none" = "none";
  public listenError: string | null = null;

  constructor(private port: number) {}

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 * 1024 });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.hubWss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 * 1024 });
    this.hubWss.on("connection", (ws) => this.onRemote(ws));

    // keepalive: detect dead plugin windows / agent processes (closed tab, sleeping laptop, killed process) quickly
    setInterval(() => {
      for (const c of [...this.conns.values(), ...this.remotes]) {
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

    this.ready = this.boot();
    await this.ready;
  }

  /** Become the hub if the port is free, otherwise attach to the running hub as a client. */
  private async boot(): Promise<void> {
    this.listenError = null;
    let lastErr = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await this.tryListen("127.0.0.1");
      if (r === "ok") {
        await this.tryListen("::1"); // the plugin's "localhost" may resolve to IPv6 loopback; failure is fine
        this.role = "hub";
        console.error(`[figma-canvas-mcp] hub: listening on ws://127.0.0.1:${this.port}`);
        return;
      }
      if (r !== "inuse") {
        this.listenError = r;
        console.error("[figma-canvas-mcp] " + r);
        return;
      }
      try {
        await this.connectClient();
        this.role = "client";
        console.error(`[figma-canvas-mcp] port ${this.port} is taken by another session: attached to its hub as a client`);
        return;
      } catch (e: any) {
        lastErr = String(e?.message ?? e);
        await sleep(200 + Math.random() * 400); // the hub may be shutting down: retry and possibly take over
      }
    }
    this.listenError = `Port ${this.port} is in use by something that is not a compatible figma-canvas-mcp hub (${lastErr}). Close it, or set FIGMA_MCP_PORT to a free port in both the MCP config and the plugin UI.`;
    console.error("[figma-canvas-mcp] " + this.listenError);
  }

  private tryListen(host: string): Promise<"ok" | "inuse" | string> {
    return new Promise((resolve) => {
      const srv = createServer((_req, res) => {
        res.writeHead(426);
        res.end("figma-canvas-mcp: WebSocket only");
      });
      srv.on("upgrade", (req, socket, head) => {
        // Figma plugin iframes report the origin "null"; agent processes send none. Reject real web origins
        // so a random web page cannot impersonate the plugin or an agent.
        const origin = req.headers.origin;
        if (origin && origin !== "null") {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        const target = (req.url ?? "/").startsWith("/hub") ? this.hubWss! : this.wss!;
        target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
      });
      srv.once("error", (err: NodeJS.ErrnoException) => {
        resolve(err.code === "EADDRINUSE" ? "inuse" : String(err.message));
      });
      srv.listen(this.port, host, () => {
        this.servers.push(srv);
        resolve("ok");
      });
    });
  }

  // ───────────────────────── hub side ─────────────────────────

  private sessions(): Session[] {
    return [this.local, ...[...this.remotes].map((r) => r.session)];
  }

  private latest(): number | undefined {
    const ids = [...this.conns.keys()];
    return ids.length ? ids[ids.length - 1] : undefined;
  }

  private currentFor(s: Session): Conn | undefined {
    return s.active !== undefined ? this.conns.get(s.active) : undefined;
  }

  private stateFor(s: Session): BridgeState {
    const c = this.currentFor(s);
    return {
      connected: !!c && c.ws.readyState === WebSocket.OPEN,
      info: c?.info ?? null,
      connections: [...this.conns.values()].map((x) => ({
        id: x.id,
        file: x.info?.fileName ?? "?",
        page: x.info?.pageName ?? "?",
        active: x.id === s.active,
        connectedSec: Math.round((Date.now() - x.since) / 1000),
      })),
    };
  }

  /** Choose the target connection by id or (partial, case-insensitive) file name. */
  private useFor(s: Session, selector: string | number): void {
    const all = [...this.conns.values()];
    const q = String(selector).toLowerCase();
    const hit = all.find((c) => String(c.id) === q) ?? all.find((c) => (c.info?.fileName ?? "").toLowerCase() === q) ?? all.find((c) => (c.info?.fileName ?? "").toLowerCase().includes(q));
    if (!hit) throw new Error(`No connected Figma file matches '${selector}'. Connected: ${all.map((c) => `${c.id}: ${c.info?.fileName}`).join(", ") || "none"}`);
    s.active = hit.id;
    s.pinned = true;
  }

  private onConnection(ws: WebSocket) {
    const conn: Conn = { id: this.nextConn++, ws, info: null, since: Date.now(), alive: true };
    this.conns.set(conn.id, conn);
    for (const s of this.sessions()) if (!s.pinned || !this.currentFor(s)) s.active = conn.id; // latest connection wins unless the agent chose one
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
      for (const s of this.sessions()) {
        if (s.active !== conn.id) continue;
        s.active = this.latest();
        s.pinned = false;
      }
      for (const [id, p] of this.pending) {
        if (p.conn !== conn.id) continue;
        clearTimeout(p.timer);
        p.reject(new Error("Figma plugin disconnected"));
        this.pending.delete(id);
      }
    });
  }

  /** An agent process (another MCP server) attached to this hub. */
  private onRemote(ws: WebSocket) {
    const remote: Remote = { ws, alive: true, session: { active: this.latest(), pinned: false } };
    this.remotes.add(remote);
    console.error(`[figma-canvas-mcp] agent session attached (${this.remotes.size} total)`);
    const send = (o: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o));
    };
    send({ hub: true });
    ws.on("pong", () => (remote.alive = true));
    ws.on("message", async (raw) => {
      remote.alive = true;
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof msg.id !== "number") return;
      try {
        let result: unknown;
        if (msg.op === "call") result = await this.callFor(remote.session, msg.method, msg.params, msg.timeoutMs, (p) => send({ id: msg.id, progress: p }));
        else if (msg.op === "use") {
          this.useFor(remote.session, msg.selector);
          result = this.stateFor(remote.session);
        } else if (msg.op === "state") result = this.stateFor(remote.session);
        else throw new Error(`Unknown hub op '${msg.op}'`);
        send({ id: msg.id, result });
      } catch (e: any) {
        send({ id: msg.id, error: String(e?.message ?? e) });
      }
    });
    ws.on("close", () => {
      this.remotes.delete(remote);
      console.error(`[figma-canvas-mcp] agent session detached (${this.remotes.size} left)`);
    });
  }

  private expire(id: number) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.reject(new Error(`Timed out after ${p.timeoutMs}ms without a reply or progress from Figma (${p.method})`));
  }

  private callFor(s: Session, method: string, params: unknown, timeoutMs = 60_000, onProgress?: Progress): Promise<any> {
    const conn = this.currentFor(s);
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

  // ───────────────────────── client side ─────────────────────────

  private connectClient(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/hub`, { maxPayload: 512 * 1024 * 1024 });
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        try {
          ws.terminate();
        } catch {
          /* closed */
        }
        reject(e);
      };
      const timer = setTimeout(() => fail(new Error("no hub handshake")), 3000);
      ws.on("error", (e) => fail(e));
      ws.on("close", () => {
        if (!settled) return fail(new Error("closed during handshake"));
        if (this.client === ws) this.clientLost();
      });
      ws.on("message", (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!settled) {
          if (msg.hub === true) {
            settled = true;
            clearTimeout(timer);
            this.client = ws;
            resolve();
          }
          return;
        }
        this.onClientMessage(msg);
      });
    });
  }

  private onClientMessage(msg: any) {
    const p = typeof msg.id === "number" ? this.clientPending.get(msg.id) : undefined;
    if (!p) return;
    if (msg.progress) {
      clearTimeout(p.timer);
      p.timer = setTimeout(() => this.clientExpire(msg.id), p.timeoutMs + 10_000);
      p.onProgress?.(msg.progress);
      return;
    }
    this.clientPending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  }

  private clientExpire(id: number) {
    const p = this.clientPending.get(id);
    if (!p) return;
    this.clientPending.delete(id);
    p.reject(new Error(`Timed out after ${p.timeoutMs}ms waiting for the hub (${p.method})`));
  }

  /** The hub went away: fail in-flight calls, then try to take over the port (or re-attach to the new hub). */
  private clientLost() {
    this.client = undefined;
    this.role = "none";
    for (const [id, p] of this.clientPending) {
      clearTimeout(p.timer);
      p.reject(new Error("The hub session closed; retry the call"));
      this.clientPending.delete(id);
    }
    console.error("[figma-canvas-mcp] hub session lost: trying to take over");
    this.ready = (async () => {
      await sleep(150 + Math.random() * 450); // desynchronise competing clients
      await this.boot();
    })();
  }

  private request(op: string, body: Record<string, unknown>, timeoutMs: number, onProgress?: Progress, method = op): Promise<any> {
    const ws = this.client;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Not attached to the hub; retry the call"));
    const id = this.nextClientId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.clientExpire(id), timeoutMs + 10_000);
      this.clientPending.set(id, { resolve, reject, timer, onProgress, timeoutMs, method });
      ws.send(JSON.stringify({ id, op, ...body }));
    });
  }

  // ───────────────────────── public API ─────────────────────────

  /** Connection snapshot for this agent: connected flag, plugin info, and every open file. */
  async state(): Promise<BridgeState> {
    await this.ready;
    if (this.listenError) return { connected: false, info: null, connections: [] };
    if (this.role === "hub") return this.stateFor(this.local);
    return this.request("state", {}, 10_000);
  }

  /** Point this agent's calls at a file (connection id or part of the file name). */
  async use(selector: string | number): Promise<BridgeState> {
    await this.ready;
    if (this.listenError) throw new Error(this.listenError);
    if (this.role === "hub") {
      this.useFor(this.local, selector);
      return this.stateFor(this.local);
    }
    return this.request("use", { selector }, 10_000);
  }

  async call(method: string, params: unknown = {}, timeoutMs = 60_000, onProgress?: Progress): Promise<any> {
    await this.ready;
    if (this.listenError) throw new Error(this.listenError);
    if (this.role === "hub") return this.callFor(this.local, method, params, timeoutMs, onProgress);
    return this.request("call", { method, params, timeoutMs }, timeoutMs, onProgress, method);
  }
}
