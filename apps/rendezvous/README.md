# @gitui/rendezvous

The meeting point for gitui's "nearby" feature: a Cloudflare Worker that lets a phone on
[gitui.diffiii.dev](https://gitui.diffiii.dev) find a `gitui` CLI on the same network and set up
a WebRTC connection to it. The protocol is in `packages/shared/src/nearby.ts`.

Hosts (the CLI) and guests (the web app) open a WebSocket to `/v1/connect`. The Worker sends it to
one Durable Object per network: the caller's public IPv4 address, or its IPv6 /64. The object
tells guests which hosts are online and relays WebRTC signals between a guest and a host. Once
the peers connect, the rendezvous sees nothing more: the data channel is direct and encrypted.
The rendezvous isn't trusted to authenticate anyone: the guest and the host run CPace with the
code the host printed, bound to both DTLS fingerprints, before the host answers any request, so
a rendezvous that swapped SDPs would fail that check. When a peer leaves, every peer of the
other role on the network gets its `gone`.

Browsers must come from `https://gitui.diffiii.dev` or an origin in the `ALLOWED_ORIGINS` var
(comma-separated). Only a socket with an allowed Origin can be a guest; the CLI sends none. This
only stops other websites from using their visitors' browsers as guests: anything that isn't a
browser can send whatever Origin it likes.

A host says hello with a display name (at most `MAX_NAME_LENGTH` code points, without control
or bidi characters: `hostName` in `@gitui/shared`) and a random per-run `secret` (`HOST_SECRET`,
32 bytes or more). The object lists it under its key, `hostKey(secret)`: the first 16 bytes of
the SHA-256 of a fixed label (`gitui-nearby-host-key`) and the secret, base64url. It keeps the key, not the secret, so only sockets with the same
secret count as that key: a co-tenant who copies a listed key can't list itself under it or
take its sockets. The CLI registers over IPv4 and IPv6 with the same secret and name; the two
sockets land in different objects, or in one when both addresses map to the same network. An
object lists each key once: the socket that joined first, then the other if that one leaves.
Both sockets still take signals.

When a peer's socket closes, the object sends `gone` with its id to every peer of the other role:
to every host when a guest leaves (a host ends that guest's session), and to every guest when a
host leaves, followed by the new host list.

Signals are checked against the contract and passed on rebuilt from its fields. The object never
acts on a `refused` signal's reason, so it relays any short slug (`REASON_SLUG`) as it came: a
newer CLI's reasons reach guests that know them, and the others read them as `unknown`.

Keepalive is free. Hosts send WebSocket protocol pings, which the runtime answers without waking
the object or calling `webSocketMessage`, and which aren't billed
([WebSocket best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/),
[pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)). Browsers can't
send those, so guests send `RENDEZVOUS_PING` (`{"type":"ping"}`) as text at any time, and the
object answers `RENDEZVOUS_PONG` (`{"type":"pong"}`) through `setWebSocketAutoResponse`, also
without waking up.

## Limits

Every text message other than the keepalive wakes the object and is billed, so the object
bounds what one client can make it do (`src/network.ts`). Every `error` it sends has a `code`
(`ErrorCode` in `@gitui/shared`), which clients act on instead of the text.

- A network holds at most `MAX_SOCKETS` (50) sockets; one more gets a 503. Each connection
  first closes the sockets that haven't said hello within `HELLO_TIMEOUT` (10 s), so silent
  sockets can't hold the slots (`hello-required`).
- At most `MAX_HOSTS` (10) hosts, counted by key, so hosts can't take the slots from guests:
  another key's hello is refused with 1013 (`host-limit`). A key already here always gets in,
  up to `MAX_SOCKETS_PER_KEY` (3) sockets (`key-limit`), so a CLI that reconnects while its old
  socket lingers isn't counted twice. The CLI says once that there's no room, and keeps
  retrying.
- Messages are counted in fixed windows of `RATE_WINDOW` (10 s): window `floor(now / 10 s)`, the
  same for every budget. A socket that hasn't said hello, or is a guest's, may send
  `GUEST_RATE_LIMIT` (50) per window, enough for a guest's hello, offer and candidates. A host
  key may send `HOST_RATE_LIMIT` (256) over all its sockets: the CLI takes at most
  `MAX_OFFERS_PER_MINUTE` (12) offers, which can all land in one window, answers each with an
  answer and at most `MAX_LOCAL_CANDIDATES` (16) candidates, and tells at most
  `MAX_REFUSALS_PER_WINDOW` (16) refusals: 12 × 17 + 16 = 220 (a test checks the limit against
  these shared constants; the hellos count against each socket's own budget). Over its limit, a
  socket is closed with 1008 (`rate-limit`), as is a host key's every socket that sends again in
  that window. Reconnecting doesn't start a key's budget over within the window.
- Binary messages close the socket with 1003, messages over `MAX_MESSAGE_LENGTH` with 1009
  (`too-large`), and invalid ones with 1008 (`invalid-message`). A signal to an unknown peer
  gets an `unknown-peer` error, which the socket's limit bounds like any other answer.

There is no budget for the network as a whole. One could only close whoever sent the most, which
over many sockets is rarely the flooder, and it would give anyone a way to close the others; it
wouldn't lower the worst case either, since every socket and key has its own budget anyway. That
worst case per window, with the sockets a network may hold at once: each socket that isn't a
host's sends at most 51 messages (the 51st closes it), and each host key 256, plus two per socket
(its hello, sent before it was a host's, and the message that closes it). The most is
`MAX_HOSTS` keys with a socket each and the other 40 sockets as guests: 10 × 258 + 40 × 51 = 4620
messages, about 460 a second. Each socket opened during the window can add 51 more, or 258 as a
new key in a host slot that a closed key freed; the [WAF rule](#deploy) allows 30 upgrades per
address per window, so one IPv4 address adds at most 30 × 258 = 7740 more (12 360 in all, about
1240 a second).

The counters live in memory, so hibernation resets them; a client has to keep the object awake
to keep counting, and then the limits apply.

What these limits don't stop: anyone on the same network, which is to say behind the same
public IPv4 address or in the same IPv6 /64, can deny nearby to the others there.

- Anyone can say hello as a host with a fresh secret, so a co-tenant can fill the `MAX_HOSTS`
  slots (`host-limit` for everyone else).
- The WAF rule in [Deploy](#deploy) counts per address, so over IPv6, where a /64 holds 2^64 of
  them, it bounds nothing, and reconnects add to the worst case above without limit.
- A client that says hello as a guest and then only sends the text keepalive, which never
  reaches the object, can hold all `MAX_SOCKETS` slots, so everyone else on the network gets a
  503 until it lets go.

Sockets already open keep working, and devices already paired don't need the rendezvous at
all; nothing else is at risk, since it only introduces peers.

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
bun run e2e        # end-to-end check against wrangler dev, on free ports in 5100–5199 (~30 s)
bun run deploy     # wrangler deploy to rendezvous.gitui.diffiii.dev (needs wrangler login)
```

`bun run dev` passes a dev-only `NETWORK_KEY_SECRET` with `--var`. To use your own, put
`NETWORK_KEY_SECRET=…` in `.dev.vars` (gitignored) and run
`bunx wrangler dev --var ALLOWED_ORIGINS:http://localhost:5173` instead. `bun run e2e` passes
wrangler an empty `--env-file`, so it never loads `.dev.vars` and can check the 500 without a
secret.

## Deploy

```sh
bunx wrangler login
# Once, before the first deploy. Changing it later moves every network to a new object, which
# only drops the sockets open at that moment.
openssl rand -base64 32 | bunx wrangler secret put NETWORK_KEY_SECRET
bun run deploy
```

The Worker is about 37 KiB gzipped (`minify` is on in `wrangler.jsonc`; check with `bunx wrangler
deploy --dry-run --outdir <dir>`). Most of it is the Effect
runtime that the shared codec's `parseClientMessage` brings (`@gitui/shared/nearby-codec`), a
cost accepted so the Worker checks messages with the same schemas as the CLI and the web app;
without it the Worker was under 10 KiB. Either way it is far below the Workers size limit.

Then, once, in the Cloudflare dashboard: a rate limiting rule that bounds reconnect floods from
one address (each new socket starts a fresh budget of its own). The free plan has one rule;
this is it.

1. The `diffiii.dev` zone → Security → WAF → Rate limiting rules → Create rule.
2. If incoming requests match: Hostname equals `rendezvous.gitui.diffiii.dev` and URI Path equals
   `/v1/connect`, i.e. the expression
   `(http.host eq "rendezvous.gitui.diffiii.dev" and http.request.uri.path eq "/v1/connect")`.
3. With the same characteristics: IP. When rate exceeds 30 requests per 10 seconds, Block for
   10 seconds (the free plan's period and duration).

A CLI opens two sockets and a browser tab one, and both reconnect with backoff, so 30 upgrades in
10 s from one address is far above what the people behind it need. Messages on an open socket
aren't requests to the WAF; the object's limits above cover those. It counts IPv4 addresses
and single IPv6 addresses, so it does little over IPv6 (see [Limits](#limits)).
