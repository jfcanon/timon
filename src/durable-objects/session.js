import { DurableObject } from "cloudflare:workers";

export class SessionDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.ctx.blockConcurrencyWhile(async () => {
      this.tasks = (await this.ctx.storage.get("tasks")) || [];
      this.subscribers = [];
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") === "websocket") {
        return this.handleWebSocketUpgrade(request);
      }
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
      this.tasks.push(body);
      await this.ctx.storage.put("tasks", this.tasks);
      this.broadcast(JSON.stringify({ type: "task_added", task: body }));
      return new Response(JSON.stringify({ ok: true }), {
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
        this.subscribers.push(ws);
        ws.send(JSON.stringify({ type: "subscribed", tasks: this.tasks }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: err.message }));
    }
  }

  async webSocketClose(ws, code, reason) {
    this.subscribers = this.subscribers.filter((s) => s !== ws);
  }

  broadcast(message) {
    for (const ws of this.subscribers) {
      try {
        ws.send(message);
      } catch (err) {
        this.subscribers = this.subscribers.filter((s) => s !== ws);
      }
    }
  }

  async addTask(taskId, intent) {
    const task = { taskId, intent, addedAt: new Date().toISOString() };
    this.tasks.push(task);
    await this.ctx.storage.put("tasks", this.tasks);
    this.broadcast(JSON.stringify({ type: "task_added", task }));
    return task;
  }
}
