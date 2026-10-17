// End-to-end tests for the item protocol: spawn the real server, talk to it
// with real WebSocket clients. Run with `npm test`.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-items-'));
const URL_BASE = `ws://127.0.0.1:${PORT}`;
let proc;

function startServer() {
  return new Promise((resolve, reject) => {
    proc = spawn(process.execPath, ['src/server.js'], {
      env: { ...process.env, PORT: String(PORT), RELAY_TOKEN: 'pub-secret', EDITOR_TOKEN: 'edit-secret', DATA_DIR },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) resolve(); });
    proc.on('error', reject);
  });
}
function stopServer() {
  return new Promise((resolve) => { proc.once('exit', resolve); proc.kill('SIGTERM'); });
}

// Client helper: collects item messages, lets tests await specific ones.
async function client({ channel = 'show', role = 'subscriber', token, owner, edit } = {}) {
  const u = new URL(URL_BASE);
  u.searchParams.set('channel', channel);
  u.searchParams.set('role', role);
  if (token) u.searchParams.set('token', token);
  const ws = new WebSocket(u);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    inbox.push(msg);
    for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
  });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const c = {
    ws, inbox,
    send: (o) => ws.send(JSON.stringify(o)),
    next(pred, ms = 1000) {
      const hit = inbox.find(pred);
      if (hit) { inbox.splice(inbox.indexOf(hit), 1); return Promise.resolve(hit); }
      return new Promise((resolve, reject) => {
        const w = { pred, resolve: (m) => { inbox.splice(inbox.indexOf(m), 1); clearTimeout(t); resolve(m); } };
        const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('timeout')); }, ms);
        waiters.push(w);
      });
    },
    async hello() {
      c.send({ relay: 'items', op: 'hello', owner, edit });
      return c.next((m) => m.op === 'sync');
    },
    async upsert(item, req = Math.random().toString(36).slice(2)) {
      c.send({ relay: 'items', op: 'upsert', req, item });
      return c.next((m) => m.op === 'ack' && m.req === req);
    },
    async del(id, req = Math.random().toString(36).slice(2)) {
      c.send({ relay: 'items', op: 'delete', req, id });
      return c.next((m) => m.op === 'ack' && m.req === req);
    },
    close: () => ws.close(),
  };
  return c;
}

const silence = (c, pred, ms = 250) => c.next(pred, ms).then(
  (m) => assert.fail(`unexpected message ${JSON.stringify(m)}`),
  () => {},
);

const OWNER_A = 'a'.repeat(32);
const OWNER_B = 'b'.repeat(32);

before(startServer);
after(async () => { await stopServer(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

test('shared items need the editor token', async () => {
  const viewer = await client({ owner: OWNER_A });
  const sync = await viewer.hello();
  assert.equal(sync.canEditShared, false);
  const ack = await viewer.upsert({ visibility: 'shared', data: { label: 'x' } });
  assert.equal(ack.ok, false);
  assert.match(ack.error, /editor/);

  const wrong = await client({ edit: 'nope' });
  assert.equal((await wrong.hello()).canEditShared, false);
  viewer.close(); wrong.close();
});

test('shared items reach every subscriber; private only the owner', async () => {
  const editor = await client({ channel: 'vis', edit: 'edit-secret', owner: OWNER_A });
  const other = await client({ channel: 'vis', owner: OWNER_B });
  const anon = await client({ channel: 'vis' });
  assert.equal((await editor.hello()).canEditShared, true);
  await other.hello(); await anon.hello();

  const s = await editor.upsert({ visibility: 'shared', data: { label: 'Pyro' } });
  assert.ok(s.ok);
  for (const c of [editor, other, anon]) {
    const put = await c.next((m) => m.op === 'put' && m.item.id === s.id);
    assert.equal(put.item.data.label, 'Pyro');
    assert.equal(put.item.mine, false);
    assert.equal(put.item.owner, undefined, 'owner hash must never be sent');
  }

  const p = await other.upsert({ visibility: 'private', data: { label: 'my note' } });
  assert.ok(p.ok);
  const mine = await other.next((m) => m.op === 'put' && m.item.id === p.id);
  assert.equal(mine.item.mine, true);
  await silence(editor, (m) => m.op === 'put' && m.item.id === p.id);
  await silence(anon, (m) => m.op === 'put' && m.item.id === p.id);

  // Late joiners: sync contents respect visibility too.
  const lateOther = await client({ channel: 'vis', owner: OWNER_B });
  const lateAnon = await client({ channel: 'vis' });
  assert.deepEqual((await lateOther.hello()).items.map((i) => i.id).sort(), [s.id, p.id].sort());
  assert.deepEqual((await lateAnon.hello()).items.map((i) => i.id), [s.id]);

  for (const c of [editor, other, anon, lateOther, lateAnon]) c.close();
});

test('nobody can edit, hijack or delete someone else\'s private item', async () => {
  const a = await client({ channel: 'own', owner: OWNER_A });
  const b = await client({ channel: 'own', owner: OWNER_B, edit: 'edit-secret' });
  await a.hello(); await b.hello();
  const p = await a.upsert({ visibility: 'private', data: { label: 'secret' } });
  assert.ok(p.ok);

  // Even an editor can't overwrite or steal it by guessing the id.
  assert.equal((await b.upsert({ id: p.id, visibility: 'private', data: { label: 'stolen' } })).ok, false);
  assert.equal((await b.upsert({ id: p.id, visibility: 'shared', data: { label: 'stolen' } })).ok, false);
  assert.equal((await b.del(p.id)).ok, false);

  // Owner can edit and delete.
  assert.ok((await a.upsert({ id: p.id, visibility: 'private', data: { label: 'v2' } })).ok);
  assert.ok((await a.del(p.id)).ok);
  await a.next((m) => m.op === 'remove' && m.id === p.id);
  a.close(); b.close();
});

test('flipping visibility sends remove to clients that lose sight of it', async () => {
  const ed = await client({ channel: 'flip', edit: 'edit-secret', owner: OWNER_A });
  const watcher = await client({ channel: 'flip', owner: OWNER_B });
  await ed.hello(); await watcher.hello();
  const s = await ed.upsert({ visibility: 'shared', data: { label: 'x' } });
  await watcher.next((m) => m.op === 'put' && m.item.id === s.id);
  assert.ok((await ed.upsert({ id: s.id, visibility: 'private', data: { label: 'x' } })).ok);
  await watcher.next((m) => m.op === 'remove' && m.id === s.id);
  const own = await ed.next((m) => m.op === 'put' && m.item.id === s.id && m.item.visibility === 'private');
  assert.equal(own.item.mine, true);
  ed.close(); watcher.close();
});

test('private items require an owner key; bad input is rejected', async () => {
  const c = await client({ channel: 'val' });
  await c.hello();
  assert.match((await c.upsert({ visibility: 'private', data: {} })).error, /owner key/);
  const k = await client({ channel: 'val', owner: OWNER_A });
  await k.hello();
  assert.equal((await k.upsert({ visibility: 'public', data: {} })).ok, false);
  assert.equal((await k.upsert({ visibility: 'private', data: 'str' })).ok, false);
  assert.equal((await k.upsert({ id: '../etc', visibility: 'private', data: {} })).ok, false);
  assert.match((await k.upsert({ visibility: 'private', data: { big: 'x'.repeat(5000) } })).error, /bytes/);
  c.close(); k.close();
});

test('items ops before hello are refused', async () => {
  const c = await client({ channel: 'pre', owner: OWNER_A });
  c.send({ relay: 'items', op: 'upsert', req: 'r1', item: { visibility: 'private', data: {} } });
  const ack = await c.next((m) => m.op === 'ack' && m.req === 'r1');
  assert.equal(ack.ok, false);
  c.close();
});

test('publishers cannot forge item messages; snapshots still pass through', async () => {
  const sub = await client({ channel: 'forge' });
  await sub.hello();
  const pub = await client({ channel: 'forge', role: 'publisher', token: 'pub-secret' });
  pub.send({ relay: 'items', op: 'put', item: { id: 'fake', data: {} } });
  pub.send({ ts: 1, running: [] });
  const snap = await sub.next((m) => m.ts === 1);
  assert.deepEqual(snap.running, []);
  await silence(sub, (m) => m.op === 'put');
  sub.close(); pub.close();
});

test('rate limit kicks in on write floods', async () => {
  const c = await client({ channel: 'flood', owner: OWNER_A });
  await c.hello();
  const acks = await Promise.all(
    Array.from({ length: 40 }, (_, i) => c.upsert({ id: 'same', visibility: 'private', data: { i } }, `r${i}`)),
  );
  assert.ok(acks.some((a) => a.error === 'rate limited'));
  c.close();
});

test('items persist across a restart', async () => {
  const ed = await client({ channel: 'persist', edit: 'edit-secret', owner: OWNER_A });
  await ed.hello();
  const s = await ed.upsert({ visibility: 'shared', data: { label: 'keep me' } });
  const p = await ed.upsert({ visibility: 'private', data: { label: 'mine' } });
  ed.close();

  await stopServer();     // SIGTERM → flush
  const files = fs.readdirSync(DATA_DIR);
  assert.ok(files.length > 0);
  const raw = files.map((f) => fs.readFileSync(path.join(DATA_DIR, f), 'utf8')).join('');
  assert.ok(!raw.includes(OWNER_A), 'raw owner key must not be stored');
  await startServer();

  const again = await client({ channel: 'persist', owner: OWNER_A });
  const items = (await again.hello()).items;
  assert.equal(items.find((i) => i.id === s.id)?.data.label, 'keep me');
  assert.equal(items.find((i) => i.id === p.id)?.mine, true);
  again.close();
});
