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
or bidi characters: `hostName` in `@gitui/shared`) and its `key`, a random per-run
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

## First test on a phone

Try nearby on a real iPhone with a separate copy of the web app at `https://gitui-test.diffiii.dev`
(the `nearby-test` env in `apps/web/wrangler.jsonc`), so `gitui.diffiii.dev` stays as it is until
the test passes. The rendezvous allows that origin through `ALLOWED_ORIGINS` in `wrangler.jsonc`.
Both custom domains need the `diffiii.dev` zone in the same Cloudflare account.

1. Deploy the rendezvous and give it its secret (from the repo root, on this branch):

   ```sh
   bun install --frozen-lockfile
   cd apps/rendezvous
   bunx wrangler login
   bunx wrangler deploy                                              # rendezvous.gitui.diffiii.dev
   openssl rand -base64 32 | bunx wrangler secret put NETWORK_KEY_SECRET   # once; applies at once
   curl -si https://rendezvous.gitui.diffiii.dev/v1/connect | head -1   # 426: it's up, secret or not
   ```

   Until the secret is set, every WebSocket gets a 500.

2. Build the web app and deploy the test copy. The default build talks to
   `wss://rendezvous.gitui.diffiii.dev`, so it needs no `VITE_GITUI_RENDEZVOUS_URL`:

   ```sh
   cd ../..
   bun run build
   cd apps/web
   bunx wrangler deploy --env nearby-test                            # gitui-test.diffiii.dev
   curl -sI https://gitui-test.diffiii.dev | grep -i content-security  # connect-src lists the rendezvous
   ```

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

5. Once it passes and nearby ships on `gitui.diffiii.dev` (`cd apps/web && bun run deploy`), remove
   the test copy and its origin:

   ```sh
   cd apps/web && bunx wrangler delete --env nearby-test
   # drop the "vars" block from apps/rendezvous/wrangler.jsonc, then:
   cd ../rendezvous && bunx wrangler deploy
   ```
