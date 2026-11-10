import { WebSocketServer } from 'ws';
import http from 'node:http';
import { URL } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ItemStore, hashOwnerKey, canSee, viewOf } from './items.js';

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.RELAY_TOKEN ?? '';
// Auth toggles per role. Both default-on for "subscribers" because the viewer
// URL needs to be share-friendly; default-off for "publishers" because writes
// should normally be authenticated. Flip PUBLIC_PUBLISHERS=true to run the
// relay fully open (e.g. when handing the bridge to someone you don't want to
// share the token with). Channel name is the only privacy left in that mode.
const PUBLIC_SUBSCRIBERS = (process.env.PUBLIC_SUBSCRIBERS ?? 'true')  !== 'false';
const PUBLIC_PUBLISHERS  = (process.env.PUBLIC_PUBLISHERS  ?? 'false') !== 'false';

// Item store (custom cues etc). Shared items need the editor token; when
// EDITOR_TOKEN is unset we fall back to RELAY_TOKEN so whoever runs the bridge
// can edit by default. Both empty = dev mode, everyone may edit shared items.
const ITEMS_ENABLED = (process.env.ITEMS_ENABLED ?? 'true') !== 'false';
const EDITOR_TOKEN = process.env.EDITOR_TOKEN || TOKEN;
// Upstream: a subscriber may send {"relay":"up","data":{...}}; forwarded as-is
// to the channel's publishers (e.g. producer page -> stage timer).
const UPSTREAM_ENABLED = (process.env.UPSTREAM_ENABLED ?? 'true') !== 'false';
const UPSTREAM_MAX = 2048;
// Stagetimer display pages (synced from the stagetimer repo). Read per request so a
// missing/late-installed dir never breaks startup.
const STATIC_DIR = path.resolve(process.env.STATIC_DIR ?? new URL('../public/stagetimer', import.meta.url).pathname);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const CODE_RE = /^\/[2-9a-hjkmnp-z]{8}$/;
const DATA_DIR = process.env.DATA_DIR ?? './data';
const store = ITEMS_ENABLED ? new ItemStore({ dataDir: DATA_DIR }) : null;

if (!TOKEN) {
  console.warn('[relay] RELAY_TOKEN is empty — connections will not be authenticated.');
}
console.log(`[relay] public subscribers: ${PUBLIC_SUBSCRIBERS ? 'YES' : 'no'}`);
console.log(`[relay] public publishers:  ${PUBLIC_PUBLISHERS  ? 'YES' : 'no'}`);
console.log(`[relay] items: ${ITEMS_ENABLED ? `enabled (data dir ${DATA_DIR}, editor token ${process.env.EDITOR_TOKEN ? 'set' : TOKEN ? '= RELAY_TOKEN' : 'NONE — dev mode'})` : 'disabled'}`);

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

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

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      const missing = file === path.join(STATIC_DIR, 'output.html');
      res.writeHead(missing ? 503 : 404, missing ? { 'content-type': 'text/plain' } : {});
      res.end(missing ? 'display pages not installed' : '');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const html = ext === '.html';
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': html ? 'no-store' : 'public, max-age=60',
      ...(html && { 'referrer-policy': 'no-referrer' }),
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split(/[?#]/)[0];
  if (pathname === '/health') {
    // Aggregates only: channel names double as share codes, never list them.
    let subscribers = 0, publishers = 0;
    for (const ch of channels.values()) { subscribers += ch.subscribers.size; publishers += ch.publishers.size; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, channels: channels.size, subscribers, publishers }));
    return;
  }
  if (req.method !== 'GET') { res.writeHead(404); res.end(); return; }
  // Share-code viewer URL: same page for any code (the page reads the code from location.pathname).
  if (CODE_RE.test(pathname)) return serveFile(res, path.join(STATIC_DIR, 'output.html'));
  if (pathname.startsWith('/stagetimer/')) {
    let rel;
    try { rel = decodeURIComponent(pathname.slice('/stagetimer/'.length)); } catch { rel = ''; }
    const file = path.resolve(STATIC_DIR, rel);
    // Resolve + prefix check; directories and "" fall through to 404 via readFile error.
    if (rel && !rel.includes('\0') && file.startsWith(STATIC_DIR + path.sep)) return serveFile(res, file);
  }
  res.writeHead(404);
  res.end();
});

function sendStats(ch) {
  const msg = JSON.stringify({ relay: 'stats', subscribers: ch.subscribers.size });
  for (const pub of ch.publishers) if (pub.readyState === pub.OPEN) pub.send(msg);
}

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
  // Auth check depends on role + the PUBLIC_* env vars (see top of file).
  const isPublic = role === 'publisher' ? PUBLIC_PUBLISHERS : PUBLIC_SUBSCRIBERS;
  const requiresAuth = !!TOKEN && !isPublic;
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
  ws.viewer = { hello: false, ownerHash: null, editor: false };
  ws.bucket = { tokens: BUCKET_SIZE, at: Date.now() };

  if (ws.role === 'subscriber') {
    ch.subscribers.add(ws);
    if (ch.lastMessage !== null) ws.send(ch.lastMessage);
    sendStats(ch);
    console.log(`[relay] +subscriber channel=${ws.channel} (now ${ch.subscribers.size})`);
  } else {
    ch.publishers.add(ws);
    console.log(`[relay] +publisher channel=${ws.channel} (now ${ch.publishers.size})`);
    sendStats(ch);
  }

  ws.on('message', (data, isBinary) => {
    if (ws.role === 'subscriber') {
      if (isBinary) return;
      const text = data.toString();
      if (UPSTREAM_ENABLED && data.length <= UPSTREAM_MAX && text.includes('"up"') && handleUpstream(ch, ws, text)) return;
      if (store) handleItemsMessage(ws, text);
      return;
    }
    const payload = isBinary ? data : data.toString();
    // The `relay: "items"` envelope is reserved for the item protocol, so a
    // publisher can't forge item updates to viewers. Cheap substring check
    // first so normal 4 Hz snapshots aren't parsed twice.
    if (typeof payload === 'string' && payload.includes('"relay"')) {
      try { if (JSON.parse(payload)?.relay === 'items') return; } catch { /* not JSON, pass through */ }
    }
    if (typeof payload === 'string') ch.lastMessage = payload;
    for (const sub of ch.subscribers) {
      if (sub.readyState === sub.OPEN) sub.send(payload, { binary: isBinary });
    }
  });

  ws.on('close', () => {
    if (ws.role === 'subscriber') ch.subscribers.delete(ws);
    else ch.publishers.delete(ws);
    console.log(`[relay] -${ws.role} channel=${ws.channel}`);
    if (ws.role === 'subscriber') sendStats(ch);
    cleanupChannel(ws.channel);
  });

  ws.on('error', (err) => console.error(`[relay] ws error channel=${ws.channel}:`, err.message));
});

// ─── Item protocol ──────────────────────────────────────────────────────────
//
// Client → relay (subscribers only), all JSON with `relay: "items"`:
//   { op: "hello", owner?: <client key>, edit?: <editor token> }
//   { op: "upsert", req?, item: { id?, visibility: "shared"|"private", data: {...} } }
//   { op: "delete", req?, id }
// Relay → client:
//   { op: "sync", items: [...], canEditShared }   reply to hello
//   { op: "put", item }  /  { op: "remove", id }  live changes this client may see
//   { op: "ack", req, ok, id?, error? }           reply to upsert/delete
//
// Secrets go in the hello message rather than the URL so they don't end up in
// the reverse proxy's access logs.

const BUCKET_SIZE = 30;      // burst of writes allowed
const BUCKET_REFILL = 5;     // writes per second sustained

function takeToken(ws) {
  const now = Date.now();
  const b = ws.bucket;
  b.tokens = Math.min(BUCKET_SIZE, b.tokens + ((now - b.at) / 1000) * BUCKET_REFILL);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Returns true if the message was an upstream envelope (consumed, forwarded or not).
function handleUpstream(ch, ws, text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return false; }
  if (msg?.relay !== 'up') return false;
  if (!takeToken(ws)) return true;
  for (const pub of ch.publishers) if (pub.readyState === pub.OPEN) pub.send(text);
  return true;
}

function sendJSON(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ relay: 'items', ...obj }));
}

function broadcastChange(channel, prev, item) {
  const ch = channels.get(channel);
  if (!ch) return;
  for (const sub of ch.subscribers) {
    if (!sub.viewer?.hello) continue;
    if (item && canSee(item, sub.viewer)) sendJSON(sub, { op: 'put', item: viewOf(item, sub.viewer) });
    else if (prev && canSee(prev, sub.viewer)) sendJSON(sub, { op: 'remove', id: prev.id });
  }
}

function handleItemsMessage(ws, text) {
  if (!text.includes('"relay"')) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg?.relay !== 'items') return;
  const items = store.get(ws.channel);
  const v = ws.viewer;

  if (msg.op === 'hello') {
    const owner = typeof msg.owner === 'string' && msg.owner.length >= 16 && msg.owner.length <= 128
      ? msg.owner : null;
    v.ownerHash = owner ? hashOwnerKey(owner) : null;
    v.editor = !EDITOR_TOKEN || (typeof msg.edit === 'string' && safeEqual(msg.edit, EDITOR_TOKEN));
    v.hello = true;
    sendJSON(ws, { op: 'sync', items: items.list(v), canEditShared: v.editor, hasOwner: !!v.ownerHash });
    return;
  }

  const req = msg.req;
  if (!v.hello) return sendJSON(ws, { op: 'ack', req, ok: false, error: 'send hello first' });
  if (!takeToken(ws)) return sendJSON(ws, { op: 'ack', req, ok: false, error: 'rate limited' });

  let result;
  if (msg.op === 'upsert') result = items.upsert(v, msg.item);
  else if (msg.op === 'delete') result = items.remove(v, msg.id);
  else return sendJSON(ws, { op: 'ack', req, ok: false, error: 'unknown op' });

  if (!result.ok) return sendJSON(ws, { op: 'ack', req, ok: false, error: result.error });
  sendJSON(ws, { op: 'ack', req, ok: true, id: result.item?.id ?? result.prev.id });
  broadcastChange(ws.channel, result.prev, result.item);
}

// Make sure debounced item writes hit disk when Docker stops the container.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    store?.flush();
    process.exit(0);
  });
}

server.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}`);
});
