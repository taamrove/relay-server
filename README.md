# relay-server

Generic WebSocket pub/sub relay. One process, many channels, shared-token auth. Built so a local-only app behind NAT can stream state to subscribers on the open internet.

## Protocol

Connect to `ws://host:8080/?token=…&channel=…&role=publisher|subscriber`.

- **publisher** — server broadcasts every message it sends to all subscribers in the same channel, and caches the last text message as the channel's "current state". **Token required.**
- **subscriber** — receives every publisher message; on connect, immediately gets the cached last message (so late joiners don't see a blank screen until the next update). **Token not required by default** (see auth below).

## Auth

The token gate is asymmetric so producers can share read-only viewer URLs without leaking the publishing secret:

| Env var | Default | Meaning |
|---|---|---|
| `RELAY_TOKEN` | _(empty)_ | Shared secret. Empty = no auth at all (dev only). |
| `PUBLIC_SUBSCRIBERS` | `true` | When true, subscribers connect without a token — the channel name is the only "secret". Set `false` to require the token on both sides. |

For a public-subscriber setup, pick non-guessable channel names (`qlab-show-2026-tonight-x7k9m2`, not `show1`). The relay does no rate-limiting; if you expose it on the open internet, put it behind a proxy that does.

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
