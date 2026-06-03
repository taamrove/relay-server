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
