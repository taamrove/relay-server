import { WebSocketServer } from 'ws';
import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.RELAY_TOKEN ?? '';
// Subscribers (read-only) get in without a token by default so the viewer can
// be shared with a stage crew via a short channel-only URL. Publishers (the
// bridge writing data) always need the token. Set PUBLIC_SUBSCRIBERS=false to
// require token auth on both sides.
const PUBLIC_SUBSCRIBERS = (process.env.PUBLIC_SUBSCRIBERS ?? 'true') !== 'false';

if (!TOKEN) {
  console.warn('[relay] RELAY_TOKEN is empty — connections will not be authenticated.');
}
console.log(`[relay] public subscribers: ${PUBLIC_SUBSCRIBERS ? 'YES (no token needed to read)' : 'no (token required)'}`);

// channel -> { subscribers:Set<ws>, publishers:Set<ws>, lastMessage:string|null }
const channels = new Map();

function getChannel(name) {
  let ch = channels.get(name);
  if (!ch) {
    ch = { subscribers: new Set(), publishers: new Set(), lastMessage: null };
    channels.set(name, ch);
  }
  return ch;
}

function cleanupChannel(name) {
  const ch = channels.get(name);
  if (ch && ch.subscribers.size === 0 && ch.publishers.size === 0) {
    channels.delete(name);
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    const stats = {};
    for (const [name, ch] of channels) {
      stats[name] = { subscribers: ch.subscribers.size, publishers: ch.publishers.size, hasState: ch.lastMessage !== null };
    }
    res.end(JSON.stringify({ ok: true, channels: stats }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token') ?? '';
  const channel = url.searchParams.get('channel') ?? '';
  const role = url.searchParams.get('role') ?? '';

  if (!channel) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\nMissing ?channel=\r\n');
    socket.destroy();
    return;
  }
  if (role !== 'publisher' && role !== 'subscriber') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n?role= must be publisher or subscriber\r\n');
    socket.destroy();
    return;
  }
  // Publishers always need the token; subscribers only if PUBLIC_SUBSCRIBERS
  // is explicitly turned off. Security trade-off documented at the top.
  const requiresAuth = !!TOKEN && (role === 'publisher' || !PUBLIC_SUBSCRIBERS);
  if (requiresAuth && token !== TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.channel = channel;
    ws.role = role;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  const ch = getChannel(ws.channel);

  if (ws.role === 'subscriber') {
    ch.subscribers.add(ws);
    if (ch.lastMessage !== null) ws.send(ch.lastMessage);
    console.log(`[relay] +subscriber channel=${ws.channel} (now ${ch.subscribers.size})`);
  } else {
    ch.publishers.add(ws);
    console.log(`[relay] +publisher channel=${ws.channel} (now ${ch.publishers.size})`);
  }

  ws.on('message', (data, isBinary) => {
    if (ws.role !== 'publisher') return;
    const payload = isBinary ? data : data.toString();
    if (typeof payload === 'string') ch.lastMessage = payload;
    for (const sub of ch.subscribers) {
      if (sub.readyState === sub.OPEN) sub.send(payload, { binary: isBinary });
    }
  });

  ws.on('close', () => {
    if (ws.role === 'subscriber') ch.subscribers.delete(ws);
    else ch.publishers.delete(ws);
    console.log(`[relay] -${ws.role} channel=${ws.channel}`);
    cleanupChannel(ws.channel);
  });

  ws.on('error', (err) => console.error(`[relay] ws error channel=${ws.channel}:`, err.message));
});

server.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}`);
});
