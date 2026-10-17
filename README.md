# relay-server

Generic WebSocket pub/sub relay. One process, many channels, shared-token auth. Built so a local-only app behind NAT can stream state to subscribers on the open internet.

## Protocol

Connect to `ws://host:8080/?token=…&channel=…&role=publisher|subscriber`.

- **publisher** — server broadcasts every message it sends to all subscribers in the same channel, and caches the last text message as the channel's "current state". **Token required.**
- **subscriber** — receives every publisher message; on connect, immediately gets the cached last message (so late joiners don't see a blank screen until the next update). **Token not required by default** (see auth below).

## Auth

The token gate is configurable per role so you can mix and match:

| Env var | Default | Meaning |
|---|---|---|
| `RELAY_TOKEN` | _(empty)_ | Shared secret. Empty = no auth at all (dev only). |
| `PUBLIC_SUBSCRIBERS` | `true` | When true, subscribers connect without a token. Set `false` to require the token from readers too. |
| `PUBLIC_PUBLISHERS` | `false` | When true, **anyone** can publish to **any** channel without a token. Channel name becomes the only protection against someone trampling your stream. Set this for hand-it-out installs where sharing the token is too much friction. |

Pick non-guessable channel names (`qlab-mainstage-2026-tonight-x7k9m2`, not `show1`) when any role is public — that's all that keeps random clients from listening to or writing into your channel. The relay does no rate-limiting; behind a public domain, put it behind a proxy that does.

Toggle either via the Makefile when deploying:

```sh
make deploy PUBLIC_PUBLISHERS=true       # fully public (no token needed by bridge or viewer)
make deploy PUBLIC_SUBSCRIBERS=false     # lock down viewer access
make deploy                              # default: public readers, authenticated writers
```

Messages are passed through untouched. Pick your own payload format per channel (JSON recommended).

`GET /health` returns channel stats as JSON.

## Items (shared & private, persisted)

Besides the pass-through stream, each channel has a small persisted **item store**. The QLab viewer uses it for custom cues, but items are opaque JSON so other projects can reuse it.

Each item is either:

- **shared**: every subscriber of the channel sees it. Creating, editing or deleting one requires the **editor token** (`EDITOR_TOKEN`, which falls back to `RELAY_TOKEN` when unset).
- **private**: only its owner sees it. The owner is identified by a random key the client generates. The relay stores only a SHA-256 of that key and never sends it back; clients get a `mine: true` flag instead. Anyone who can subscribe may create private items, since they only affect themselves.

Subscribers speak the protocol over the same socket, using JSON messages tagged `relay: "items"`:

| Direction | Message |
|---|---|
| → relay | `{ relay:"items", op:"hello", owner?, edit? }` |
| → relay | `{ relay:"items", op:"upsert", req?, item:{ id?, visibility:"shared"\|"private", data:{…} } }` |
| → relay | `{ relay:"items", op:"delete", req?, id }` |
| ← relay | `{ op:"sync", items, canEditShared, hasOwner }` (reply to hello) |
| ← relay | `{ op:"put", item }` / `{ op:"remove", id }` (live changes you're allowed to see) |
| ← relay | `{ op:"ack", req, ok, id?, error? }` |

Design notes:

- **Secrets go in `hello`, not the URL**, so the owner key and editor token don't end up in Nginx Proxy Manager's access logs.
- **Publishers can't send `relay:"items"` messages.** The relay drops them, so a publisher can't forge items into viewers.
- **Both the old and new visibility are permission-checked.** An editor can't take over someone's private item by id, and a viewer can't flip a shared item to private.
- **Limits:** 4 KB per item, 2000 items per channel, 300 private items per owner, and a token-bucket rate limit of 30 burst / 5 writes per second per socket.
- **Persistence:** one JSON file per channel in `DATA_DIR`, named by a hash of the channel. Writes are debounced and atomic (tmp + rename), and pending writes are flushed on SIGTERM.

| Env var | Default | Meaning |
|---|---|---|
| `EDITOR_TOKEN` | `RELAY_TOKEN` | Password for editing shared items. Both empty = dev mode, everyone can edit. |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where item files are written. |
| `ITEMS_ENABLED` | `true` | Set `false` to turn the store off entirely. |

The Makefile mounts `DATA_HOST_DIR` (default `/mnt/user/appdata/relay-server-data`) at `/data`. It deliberately lives outside `REMOTE_DIR`, because `make sync` runs `rsync --delete` there. Use `make rotate-editor-token` for a separate editing password you can hand to, for example, a stage manager without giving away the publisher token.

Run the tests with `npm test`. They spawn the server and use real WebSocket clients.

## Run locally

```sh
npm install
RELAY_TOKEN=dev npm run dev
```

## Deploy on Unraid

Use the Makefile — it handles rsync, build, restart, and (critically) writes the token to `.deployed-token` *without* a trailing newline so `pbcopy < .deployed-token` produces a paste-safe value:

```sh
make rotate-token   # first time, or whenever you want to invalidate the old token
make deploy         # subsequent code-only redeploys
make health         # curl /health
make logs           # tail container logs
```

Override the host with `HOST=root@10.0.0.42 make deploy` if you ever move the service.

The relay needs to live behind a reverse proxy that does TLS and WebSocket upgrade — currently Nginx Proxy Manager on Unraid → `wss://relay.trv.as`.

## Reuse

There's nothing QLab-specific here. Any project that needs to push state from a private network to a public viewer can pick a unique `channel` name and reuse this relay.
