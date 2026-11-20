# gitui

A lazygit-inspired git client that runs in your browser on localhost.

- **Changes**: staged and unstaged files as trees ([@pierre/trees](https://www.npmjs.com/package/@pierre/trees)). Stage, unstage or discard from the row menu (right-click, or the row button); double-click a file to toggle it. Commit or amend with ⌘↵.
- **History**: commit graph across all branches or just the current one, with commit details, a tree of changed files and syntax-highlighted diffs ([@pierre/diffs](https://diffs.com)).
- **Branches**: local and remote branches. Checkout (double-click), create, delete, and see each branch's log.
- **Files**: the working copy as it is on disk, uncommitted edits and untracked files included (ignored ones aren't), with each file syntax-highlighted. Binary files and files over 1 MB show only their size; symlinks show their target.
- Fetch, pull (`--ff-only`) and push from the header. Push sets an upstream when there isn't one.
- Unified or split diffs, and light, dark or system theme.

## Usage

Needs `git`, and Node.js 22.1 or later or Bun. Run it without installing:

```sh
npx @diffiii/gitui@latest       # Node
bunx @diffiii/gitui@latest      # Bun, or Node when it's installed (`bunx --bun` forces Bun)
```

Or install it (`npm i -g @diffiii/gitui`) and run `gitui`. Arguments work the same either way:

```sh
gitui                     # open the repository picker
gitui .                   # open the repository containing the current directory
gitui ~/code/x -p 5000 --no-open
gitui --local             # serve the UI bundled in the package instead of using the hosted app
gitui --lan               # serve the bundled UI on your network, to use from your phone
gitui --nearby            # also let a phone on your network find and connect to this machine
```

By default gitui serves only the API and opens the hosted app at https://gitui.diffiii.dev through a pairing link it prints. The link carries the port and a pairing token (kept in `~/.config/gitui/token`; delete it to rotate the token), so a browser stays paired across restarts. `--local` serves the UI from the package on localhost and opens that instead, for offline use or browsers that may block the hosted page from reaching localhost (Safari); the pairing link is printed either way. `--allow-origin <origin>` (repeatable) lets another web app origin pair too, e.g. a self-hosted copy or a local build.

`--lan [address]` serves the bundled UI on this machine's network address and prints a link and a QR code for a phone or another device on the same network. By default it picks the default route's IPv4 address, or another of this machine's, as long as it is private (10/8, 172.16/12 or 192.168/16); otherwise pass the IPv4 address to use, e.g. a Tailscale address (100.64/10, which gitui doesn't pick by itself: carrier-grade NAT uses that range too, and other customers of the ISP share it). The link sets a session cookie, which every API request then needs; its key is made per run, so restarting gitui unpairs every device. It travels over plain HTTP, so use it on trusted networks only (home Wi-Fi or a phone hotspot, not public Wi-Fi). Cookies ignore ports, so any other web service on the same address receives the session cookie too: only use it on a machine whose other services you trust. LAN mode serves its own UI only: the hosted app can't pair with it, and it never opens a browser.

`--nearby` (with the default hosted mode or `--local`, not `--lan`) also lists this machine, under its hostname or `--name <name>`, on a rendezvous service for phones on the same network (the same public IP): opening https://gitui.diffiii.dev there shows it. The phone then connects over an encrypted WebRTC data channel, straight to this machine when the network allows, and must enter the 6-digit code gitui prints for that connection (3 tries) before anything is served. The rendezvous service only relays the connection setup, and the code is bound to the connection's DTLS fingerprints, so the service can't take the connection over. `GITUI_RENDEZVOUS_URL` (a `ws:` or `wss:` origin) points it at another rendezvous service, e.g. `wrangler dev`'s.

## Development

```sh
bun install
bun run dev [repo-path]   # API on :4777 (bun --watch) + Vite+ dev server with /api proxy
GITUI_ALLOW_ORIGIN=http://localhost:5173 bun run dev   # also accept that origin cross-origin
vp check                  # format, lint, type check
bun test                  # run the tests
bun run build             # type check, build the UI and bundle the CLI into apps/cli/dist/
bun apps/cli/bin/gitui.ts # run the CLI from source (`--local` serves the UI from apps/cli/dist/web)
scripts/smoke.sh          # start the built bundle with node in both modes and check what it serves
```

## Releasing

`.github/workflows/release.yml` publishes `apps/cli` as `@diffiii/gitui` with npm trusted publishing (OIDC, no token), which also adds provenance. To release, bump `version` in `apps/cli/package.json`, commit, then push a matching tag: `git tag v0.1.0 && git push origin v0.1.0`. The workflow fails if the tag isn't `v` + that version.

One-time setup: create a GitHub environment named `npm` (Settings → Environments; optionally restrict it to `v*` tags), then on npmjs.com: package → Settings → Trusted publishing → GitHub Actions, with user `diffiii`, repository `gitui`, workflow `release.yml` and environment `npm`. That page only exists once the package does, so the first version may have to be published by hand (`bun run build`, `cd apps/cli && bun pm pack`, then `npm publish <tarball>` from outside the repo, since npm refuses to run inside it because of the root `devEngines`).

## How it works

- `apps/cli/` (`@diffiii/gitui`): the `gitui` CLI and a [Hono](https://hono.dev) API (`server/`) that shells out to the `git` CLI (`server/git.ts`). It listens on 127.0.0.1 only, rejects requests whose `Host` isn't localhost, and requires an `x-gitui` header on every API request. Cross-origin requests are refused unless they come from an allowed origin (the hosted app, plus any `--allow-origin`), and those must also send the pairing token as a bearer token, so other websites can't drive it. With `--lan` it listens on a network address instead, accepts only that address as `Host`, refuses cross-origin pages, and requires the session cookie from its pairing link (`/pair?key=…`) on every API request. With `--nearby` it also keeps a WebSocket to the rendezvous service and answers phones' WebRTC offers (`server/nearby/`, with [werift](https://github.com/shinyoshiaki/werift-webrtc)); their requests travel over the data channel to an app of their own, which the authenticated channel lets in. `bun run build` bundles it into one Node-compatible file (`dist/gitui.js`) next to a copy of the built UI (`dist/web`, whose `index.html` gets the `gitui-local-ui` meta tag that tells the app it is served by the CLI), which is what the npm package ships, with `apps/cli/README.md` and the root `LICENSE`.
- `apps/web/`: React, Tailwind v4, shadcn/ui and TanStack Query. Status polls every 3s, and every mutation refreshes the repo's queries.
- `packages/shared/` (`@gitui/shared`): API types and connection constants used by both sides.
- Recent repositories are stored in `~/.config/gitui/recent.json`.

## Hosted web app

The git backend needs a real filesystem and the `git` binary, so only the static UI is hosted on Cloudflare, at https://gitui.diffiii.dev (Workers static assets, `apps/web/wrangler.jsonc`). The page talks to the CLI on `http://127.0.0.1:<port>` straight from the browser:

- `gitui` prints and opens a pairing link (`https://…/#port=…&token=…`). The page saves the pairing fragment in localStorage and drops it from the address bar; API calls then send the token as a bearer token.
- Pages served by gitui itself (the CLI's bundled UI, or the Vite dev server of `bun run dev`) carry a `<meta name="gitui-local-ui">` tag (`LOCAL_UI_META`); they skip pairing and call `/api` same-origin, whatever their host. The production build (`vp build`), which is what gets deployed, has no such tag, so any page served from it pairs, even on localhost.
- `HOSTED_ORIGIN` in `packages/shared/src/connection.ts` must match the custom domain in `wrangler.jsonc`: the CLI only accepts that origin (plus any `--allow-origin`) and builds pairing links from it.

Deploy once from a machine logged in to Cloudflare (`wrangler login`):

```sh
cd apps/web && bun run deploy   # the root `bun run build` (type check + vp build), then wrangler deploy
```

Or connect the repository in Cloudflare Workers Builds with:

- Root directory: `/` (the repo root, so the whole workspace installs)
- Build variable: `BUN_VERSION=1.4.5` (the version `devEngines` and CI pin, which reads this `bun.lock`)
- Build command: `bun run build`
- Deploy command: `cd apps/web && bunx wrangler deploy`

`wrangler deploy` attaches the custom domain `gitui.diffiii.dev` (its zone must be in the same Cloudflare account) and turns off the `workers.dev` and preview URLs: the CLI wouldn't accept their origins.

To try the hosted mode locally, serve a production build of the UI, which lacks the marker, and let the dev API accept its origin:

```sh
cd apps/web && bunx vp build && bunx vp preview                        # the built UI on http://localhost:4173
GITUI_ALLOW_ORIGIN=http://localhost:4173 bun run --cwd apps/cli dev   # API; prints a pairing link for that origin
```

Then open the printed pairing link (`http://localhost:4173/#port=…&token=…`). Any static server for `apps/web/dist` works the same way, with its origin in `GITUI_ALLOW_ORIGIN`. Rebuild after changing the UI; the Vite dev server (`bun run dev`) is always the local mode.

## License

[MIT](LICENSE)
