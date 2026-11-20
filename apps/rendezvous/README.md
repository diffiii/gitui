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
the secret's SHA-256, base64url. It keeps the key, not the secret, so only sockets with the same
secret count as that key: a co-tenant who copies a listed key can't list itself under it or
take its sockets. The CLI registers over IPv4 and IPv6 with the same secret and name; the two
sockets land in different objects, or in one when both addresses map to the same network. An
object lists each key once: the socket that joined first, then the other if that one leaves.
Both sockets still take signals.

When a peer's socket closes, the object sends `gone` with its id to every peer of the other role:
to every host when a guest leaves (a host ends that guest's session), and to every guest when a
host leaves, followed by the new host list.

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
  `MAX_REFUSALS_PER_WINDOW` (16) refusals: 1 + 12 × 17 + 16 = 221 (a test checks the limit
  against these shared constants). Over its limit, a socket is closed with 1008 (`rate-limit`),
  as is a host key's every socket that sends again in that window. Reconnecting doesn't start a
  key's budget over within the window.
- The network's guests and sockets that haven't said hello share `NETWORK_RATE_LIMIT` (200) per
  window, and its hosts share `NETWORK_HOST_RATE_LIMIT` (512, two keys at their limit). Over
  either, whoever sent the most in the window is closed with 1013 (`network-rate-limit`): the
  socket, or for hosts every socket of the key. That happens whoever sent the last message, and
  the closed sockets' messages stop counting, so the others go on.
- Binary messages close the socket with 1003, messages over `MAX_MESSAGE_LENGTH` with 1009
  (`too-large`), and invalid ones with 1008 (`invalid-message`). A signal to an unknown peer
  gets an `unknown-peer` error, which the socket's limit bounds like any other answer.

The worst case per window, with the sockets a network may hold at once: each socket that isn't
a host's sends at most 51 messages (the 51st closes it), and each host key 256, plus two per
socket (its hello, sent before it was a host's, and the message that closes it). The network
budgets don't lower that, since they stop counting what they close: the most is `MAX_HOSTS`
keys with a socket each and the other 40 sockets as guests, 10 × 258 + 40 × 51 = 4620
messages, about 460 a second. Each socket opened during the window can add 51 more, or 258 as
a new key in a host slot that a closed key freed. (Before host keys shared a budget,
it was 30 host sockets × 201 + 20 × 51 = 7050.)

The counters live in memory, so hibernation resets them; a client has to keep the object awake
to keep counting, and then the limits apply.

What these limits don't stop: anyone on the same network, which is to say behind the same
public IPv4 address or in the same IPv6 /64, can deny nearby to the others there.

- The network budgets close whoever sent the most, which is the flooder only when its traffic
  comes from a few sockets. Spread over many sockets, each sending less than a pairing guest
  (or host) does, a flood closes the one that is pairing instead.
- Anyone can say hello as a host with a fresh secret, so a co-tenant can fill the `MAX_HOSTS`
  slots (`host-limit` for everyone else) or spend the hosts' network budget.
- The WAF rule in [Deploy](#deploy) counts per address, so over IPv6, where a /64 holds 2^64 of
  them, it bounds nothing, and reconnects add to the worst case above.
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

## First test on a phone

Try nearby on a real iPhone with a separate copy of the web app at `https://gitui-test.diffiii.dev`
(`apps/web/wrangler.nearby-test.jsonc`), so `gitui.diffiii.dev` stays as it is until the test
passes. The rendezvous allows that origin through `ALLOWED_ORIGINS` in `wrangler.jsonc`. Both
custom domains need the `diffiii.dev` zone in the same Cloudflare account.

1. Deploy the rendezvous and give it its secret (from the repo root, on this branch):

   ```sh
   bun install --frozen-lockfile
   cd apps/rendezvous
   bunx wrangler login
   bunx wrangler deploy                                              # rendezvous.gitui.diffiii.dev
   openssl rand -base64 32 | bunx wrangler secret put NETWORK_KEY_SECRET   # once; applies at once
   curl -si https://rendezvous.gitui.diffiii.dev/v1/connect | head -1   # 426: it's up, secret or not
   ```

   Until the secret is set, every WebSocket gets a 500. Add the WAF rule from [Deploy](#deploy).

2. Build the web app and deploy the test copy. Wrangler builds first (`build` in the wrangler
   configs), with `VITE_GITUI_RENDEZVOUS_URL` cleared, so the copy talks to
   `wss://rendezvous.gitui.diffiii.dev` and its CSP allows it, whatever your environment or
   `dist/` held before. The same goes for any `wrangler deploy` in `apps/web`, run anywhere in
   the repo:

   ```sh
   cd ../web
   bun run deploy:nearby-test                                        # gitui-test.diffiii.dev
   curl -sI https://gitui-test.diffiii.dev | grep -i content-security  # connect-src lists the rendezvous
   ```

   It deploys with `-c wrangler.nearby-test.jsonc`, a separate Worker (`gitui-nearby-test`) on
   its own domain, so it can't touch `gitui.diffiii.dev`.

3. On the Mac, from the repo root, run the CLI from this branch with a repository:

   ```sh
   node apps/cli/dist/gitui.js ~/code/some-repo --nearby          # or: bun apps/cli/bin/gitui.ts …
   ```

   It prints `Nearby: visible as '<name>' (IPv4, IPv6) on this network`. It says to open
   gitui.diffiii.dev, but for this test open the test copy instead. Put the Mac and the iPhone on
   the same Wi-Fi network, with VPNs off. iCloud Private Relay sends Safari's traffic from another
   address, which puts the phone on another network, so turn it off for the test (Settings →
   your name → iCloud → Private Relay).

4. On the iPhone, open `https://gitui-test.diffiii.dev` in Safari and check:

   - The Mac is listed. Tap it: the terminal prints a code. Enter it: the app opens on the
     repository.
   - Changes, History (open a commit), Branches and Files (open a file) all load. Stage a file.
   - Reload the page: it reconnects with no new code (`Nearby: a device reconnected`).
   - Lock the phone for a minute, or switch to another app and back: it reconnects, with no code.
   - In the repository switcher, type the path of a repository you haven't opened on the Mac:
     the picker says it wasn't opened on the computer, and `~/.config/gitui/recent.json` is
     unchanged.
   - Enter a wrong code 3 times on a new connection (Disconnect from the ⋮ menu, then tap the
     Mac again): gitui hangs up and the terminal says so. Try again with the right code.
   - Stop and restart gitui: the phone says gitui restarted and asks for the new code.
   - Disconnect from the ⋮ menu: the list comes back, and the terminal says
     `Nearby: device disconnected`.

5. Once it passes and nearby ships on `gitui.diffiii.dev` (`cd apps/web && bun run deploy`),
   remove the test copy and its origin:

   ```sh
   cd apps/web && bunx wrangler delete -c wrangler.nearby-test.jsonc   # the gitui-nearby-test Worker
   ```

   - Delete `apps/web/wrangler.nearby-test.jsonc` and its `deploy:nearby-test` script in
     `apps/web/package.json`.
   - Drop the `ALLOWED_ORIGINS` var and its comment from `apps/rendezvous/wrangler.jsonc`, then
     `cd apps/rendezvous && bunx wrangler deploy`.
   - Drop the sentence about the test copy from `CLAUDE.md` (the `apps/web/` entry).
