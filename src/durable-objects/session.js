import { DurableObject } from "cloudflare:workers";

export class SessionDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.tasks = [];
    this.subscribers = [];
    this.ctx.blockConcurrencyWhile(async () => {
      this.tasks = (await this.ctx.storage.get("tasks")) || [];
      this.subscribers = [];
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    if (url.pathname === "/ws" || url.pathname === "/api/ws") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    if (url.pathname === "/tasks" && request.method === "GET") {
      return new Response(JSON.stringify({ tasks: this.tasks }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/tasks" && request.method === "POST") {
      const body = await request.json();
      return new Response(JSON.stringify({ ok: true, task: await this.addTask(body) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  handleWebSocketUpgrade(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      if (data.type === "subscribe") {
        if (!this.subscribers.includes(ws)) this.subscribers.push(ws);
        ws.send(JSON.stringify({ type: "subscribed", tasks: this.tasks }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: err.message }));
    }
  }

  async webSocketClose(ws, code, reason) {
    this.subscribers = this.subscribers.filter((s) => s !== ws);
  }

  sockets() {
    if (typeof this.ctx.getWebSockets === "function") {
      return this.ctx.getWebSockets();
    }
    return this.subscribers;
  }

  broadcast(message) {
    for (const ws of this.sockets()) {
      try {
        ws.send(message);
      } catch (err) {
        this.subscribers = this.subscribers.filter((s) => s !== ws);
      }
    }
  }

  async persist() {
    await this.ctx.storage.put("tasks", this.tasks);
  }

  async addTask(task) {
    const id = task.id;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.tasks.push(task);
    await this.persist();
    this.broadcast(JSON.stringify({ type: "task_added", task }));
    return task;
  }

  async updateTask(task) {
    const id = task.id;
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx >= 0) this.tasks[idx] = task;
    else this.tasks.push(task);
    await this.persist();
    this.broadcast(JSON.stringify({ type: "task_updated", task }));
    return task;
  }

  async removeTask(task) {
    const payload = typeof task === "string" ? { id: task } : task;
    const id = payload.id;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    await this.persist();
    this.broadcast(JSON.stringify({ type: "task_deleted", task: payload }));
    return payload;
  }
}
