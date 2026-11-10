// Upstream envelope + producer page. Own server instances (own ports).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const procs = [];
async function start(env = {}) {
  const port = 19000 + Math.floor(Math.random() * 900);
  const proc = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(port), RELAY_TOKEN: 'pub', EDITOR_TOKEN: 'ed',
      DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'relay-up-')), ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  procs.push(proc);
  await new Promise((r) => proc.stdout.on('data', (d) => d.toString().includes('listening') && r()));
  return port;
}
after(() => procs.forEach((p) => p.kill('SIGTERM')));

async function conn(port, role, channel = 'c') {
  const q = new URLSearchParams({ channel, role, ...(role === 'publisher' ? { token: 'pub' } : {}) });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?${q}`);
  ws.inbox = [];
  ws.on('message', (d, bin) => ws.inbox.push(bin ? d : d.toString()));
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return ws;
}
const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const UP = JSON.stringify({ relay: 'up', data: { op: 'message', text: 'hi' } });

test('upstream reaches publishers only, is not cached', async () => {
  const port = await start();
  const pub = await conn(port, 'publisher'), sub = await conn(port, 'subscriber'), other = await conn(port, 'subscriber');
  sub.send(UP);
  await wait();
  assert.deepEqual(pub.inbox, [UP]);
  assert.deepEqual(other.inbox, []);
  assert.deepEqual(sub.inbox, []);
  const late = await conn(port, 'subscriber');
  await wait();
  assert.deepEqual(late.inbox, []);
  // other subscriber text and non-"up" envelopes never reach the publisher
  sub.send(JSON.stringify({ relay: 'other', x: 1 })); sub.send('plain'); sub.send(JSON.stringify({ hello: 1 }));
  await wait();
  assert.equal(pub.inbox.length, 1);
  // publisher still can't forge items
  pub.send(JSON.stringify({ relay: 'items', op: 'put', item: { id: 'x' } }));
  await wait();
  assert.deepEqual(other.inbox, []);
  // other channels are isolated
  const pub2 = await conn(port, 'publisher', 'd');
  sub.send(UP); await wait();
  assert.deepEqual(pub2.inbox, []);
});

test('oversize upstream is dropped, rate limited', async () => {
  const port = await start();
  const pub = await conn(port, 'publisher'), sub = await conn(port, 'subscriber');
  sub.send(JSON.stringify({ relay: 'up', data: { pad: 'x'.repeat(2100) } }));
  await wait();
  assert.equal(pub.inbox.length, 0);
  for (let i = 0; i < 60; i++) sub.send(UP);
  await wait(400);
  assert.ok(pub.inbox.length > 0 && pub.inbox.length < 60, `got ${pub.inbox.length}`);
});

test('UPSTREAM_ENABLED=false blocks forwarding', async () => {
  const port = await start({ UPSTREAM_ENABLED: 'false' });
  const pub = await conn(port, 'publisher'), sub = await conn(port, 'subscriber');
  sub.send(UP);
  await wait();
  assert.equal(pub.inbox.length, 0);
});

test('GET /p/:token serves the producer page, no-store', async () => {
  const port = await start();
  const r = await fetch(`http://127.0.0.1:${port}/p/abc`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await r.text(), /<title>Producer<\/title>/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/p/`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/public/producer.html`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
});
