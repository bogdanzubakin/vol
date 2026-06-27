const WebSocket = require("ws");

function attachDashboardWebSocket(server, options = {}) {
  const { getSnapshot, auth } = options;
  const wss = new WebSocket.Server({ noServer: true });
  const clients = new Set();
  const throttleAt = new Map();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    if (auth?.config?.enabled) {
      const session = auth.getSession(req);
      if (!session?.ok) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
    if (getSnapshot) {
      Promise.resolve(getSnapshot())
        .then((data) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ channel: "snapshot", data }));
          }
        })
        .catch((e) => {
          console.error(`Dashboard WS snapshot: ${e.message}`);
        });
    }
  });

  function send(channel, data) {
    const payload = JSON.stringify({ channel, data });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  function broadcast(channel, data) {
    if (!clients.size) return;
    send(channel, data);
  }

  function broadcastThrottled(channel, getData, ms = 1000) {
    if (!clients.size) return;
    const now = Date.now();
    const last = throttleAt.get(channel) ?? 0;
    if (now - last < ms) return;
    throttleAt.set(channel, now);
    Promise.resolve(getData())
      .then((data) => {
        if (data != null) send(channel, data);
      })
      .catch((e) => {
        console.error(`Dashboard WS ${channel}: ${e.message}`);
      });
  }

  return { broadcast, broadcastThrottled, clientCount: () => clients.size };
}

module.exports = { attachDashboardWebSocket };
