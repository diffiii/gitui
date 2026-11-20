# @gitui/rendezvous

The meeting point for gitui's "nearby" feature: a Cloudflare Worker that lets a phone on
[gitui.diffiii.dev](https://gitui.diffiii.dev) find a `gitui` CLI on the same network and set up
a WebRTC connection to it. The protocol is in `packages/shared/src/nearby.ts`.

Hosts (the CLI) and guests (the web app) open a WebSocket to `/v1/connect`. The Worker sends it to
one Durable Object per network: the caller's public IPv4 address, or its IPv6 /64. The object
tells guests which hosts are online and relays WebRTC signals between a guest and a host. Once
the peers connect, the rendezvous sees nothing more: the data channel is direct and encrypted,
and the guest proves it knows the code the host printed before the host answers any request.

Browsers must come from `https://gitui.diffiii.dev` or an origin in the `ALLOWED_ORIGINS` var
(comma-separated). Only a socket with an allowed Origin can be a guest; the CLI sends none.

A host says hello with a display name (at most `MAX_NAME_LENGTH`) and its `key`, a random per-run
id (`HOST_KEY`). The CLI registers over IPv4 and IPv6 with the same key and name; the two
sockets land in different objects, or in one when both addresses map to the same network. An
object lists each key once: the socket that joined first, then the other if that one leaves.
Both sockets still take signals.

Keepalive is free. Hosts send WebSocket protocol pings, which the runtime answers without waking
the object or calling `webSocketMessage`, and which aren't billed
([WebSocket best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/),
[pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)). Browsers can't
send those, so guests send `RENDEZVOUS_PING` (`{"type":"ping"}`) as text at any time, and the
object answers `RENDEZVOUS_PONG` (`{"type":"pong"}`) through `setWebSocketAutoResponse`, also
without waking up.

## Privacy

- Nothing is stored. Presence is the set of open sockets: a host's id and display name exist
  only while its socket is open, and only guests on the same network see them.
- The Worker logs nothing (Workers Logs are off) and never records addresses or names.
  Objects are named by an HMAC-SHA256 of the network, keyed by the `NETWORK_KEY_SECRET` secret,
  so a name can't be traced back to an address by trying every IPv4 address. Without the
  secret the Worker refuses every connection with a 500.
- Signals (SDP offers, answers and ICE candidates) pass through the object in memory and are
  forwarded only to the peer they're addressed to. They contain local and public addresses, as
  WebRTC signals always do.

## Commands

```sh
bun run dev        # wrangler dev on :8787, allowing http://localhost:5173 as a guest origin
bun test src       # unit tests (from the repo root: bun test apps/rendezvous)
bun run e2e        # end-to-end check against wrangler dev on :5187 and :5188 (PORT=… to move)
bun run deploy     # wrangler deploy to rendezvous.gitui.diffiii.dev (needs wrangler login)
```

`bun run dev` passes a dev-only `NETWORK_KEY_SECRET` with `--var`. To use your own, put
`NETWORK_KEY_SECRET=…` in `.dev.vars` (gitignored) and run
`bunx wrangler dev --var ALLOWED_ORIGINS:http://localhost:5173` instead.

## Deploy

```sh
bunx wrangler login
# Once, before the first deploy. Changing it later moves every network to a new object, which
# only drops the sockets open at that moment.
openssl rand -base64 32 | bunx wrangler secret put NETWORK_KEY_SECRET
bun run deploy
```
