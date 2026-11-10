// Upstream envelope, stagetimer routes, stats, health. Own server instances (own ports).
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
  ws.inbox = []; ws.stats = [];
  ws.on('message', (d, bin) => {
    const t = bin ? d : d.toString();
    if (!bin && t.includes('"stats"') && JSON.parse(t).relay === 'stats') ws.stats.push(JSON.parse(t).subscribers);
    else ws.inbox.push(t);
  });
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

test('stagetimer routes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-st-'));
  fs.mkdirSync(path.join(dir, 'js'));
  const none = await start({ STATIC_DIR: path.join(dir, 'nope') });
  const code = '23456789';
  let r = await fetch(`http://127.0.0.1:${none}/${code}`);
  assert.equal(r.status, 503);
  assert.match(await r.text(), /display pages not installed/);

  fs.writeFileSync(path.join(dir, 'output.html'), '<title>Out</title>');
  fs.writeFileSync(path.join(dir, 'js', 'a.js'), '1');
  fs.writeFileSync(path.join(dir, 'a.css'), 'a{}');
  fs.writeFileSync(path.join(dir, 'a.svg'), '<svg/>');
  fs.writeFileSync(path.join(dir, 'a.json'), '{}');
  fs.writeFileSync(path.join(dir, 'a.woff2'), 'x');
  const port = await start({ STATIC_DIR: dir });
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`);
  r = await get(`/${code}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await r.text(), /<title>Out<\/title>/);
  assert.equal((await get(`/${code}?x=1`)).status, 200);
  for (const bad of ['/23456780', '/2345678', '/234567890', '/2345678l', '/ABCDEFGH', '/p/abc', '/public/producer.html', '/stagetimer/', '/stagetimer/js',
    '/stagetimer/../src/server.js', '/stagetimer/%2e%2e/src/server.js', '/stagetimer/..%2fsrc%2fserver.js', '/stagetimer/%2e%2e%2fsrc%2fserver.js',
    '/stagetimer/js/..%2f..%2fsrc/server.js', '/stagetimer/%00', '/stagetimer/nope.js'])
    assert.equal((await get(bad)).status, 404, bad);
  for (const [f, type] of [['output.html', 'text/html'], ['js/a.js', 'text/javascript'], ['a.css', 'text/css'],
    ['a.svg', 'image/svg+xml'], ['a.json', 'application/json'], ['a.woff2', 'font/woff2']]) {
    r = await get(`/stagetimer/${f}`);
    assert.equal(r.status, 200, f);
    assert.ok(r.headers.get('content-type').startsWith(type), f);
    assert.equal(r.headers.get('cache-control'), f.endsWith('.html') ? 'no-store' : 'public, max-age=60', f);
  }
});

test('stats goes to publishers on connect/join/leave, never subscribers', async () => {
  const port = await start();
  const pub = await conn(port, 'publisher');
  await wait();
  assert.deepEqual(pub.stats, [0]);
  const s1 = await conn(port, 'subscriber'), s2 = await conn(port, 'subscriber');
  await wait();
  s1.close(); await wait();
  s2.close(); await wait();
  assert.deepEqual(pub.stats, [0, 1, 2, 1, 0]);
  const pub2 = await conn(port, 'publisher'); // second publisher gets it on connect, too
  const s3 = await conn(port, 'subscriber');
  await wait();
  assert.deepEqual(pub2.stats, [0, 1]);
  assert.deepEqual(s3.stats, []);
  assert.deepEqual(s3.inbox, []);
  assert.deepEqual(pub.inbox, []);
});

test('/health returns aggregates only', async () => {
  const port = await start();
  await conn(port, 'publisher', 'secretcode'); await conn(port, 'subscriber', 'secretcode'); await conn(port, 'subscriber', 'other');
  const body = await (await fetch(`http://127.0.0.1:${port}/health`)).text();
  assert.deepEqual(JSON.parse(body), { ok: true, channels: 2, subscribers: 2, publishers: 1 });
  assert.ok(!body.includes('secretcode'));
});
