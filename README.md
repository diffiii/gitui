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
gitui --nearby            # also let a phone on your network find and connect to this machine
```

gitui serves the API on 127.0.0.1 and opens the hosted app at https://gitui.diffiii.dev through a pairing link it prints. The link carries the port and a pairing token (kept in `~/.config/gitui/token`; delete it to rotate the token), so a browser stays paired across restarts. Desktop Safari blocks the hosted page from reaching 127.0.0.1: run `gitui --nearby` and pick this computer from the nearby list instead, with iCloud Private Relay off (it makes Safari look like it is on another network). `--allow-origin <origin>` (repeatable) lets another web app origin pair too, e.g. a self-hosted copy or a local build.

`--nearby` also lists this machine, under its hostname or `--name <name>`, on a rendezvous service for phones on the same network (the same public IPv4 or IPv6 address; gitui registers over both): opening https://gitui.diffiii.dev there shows it. The phone then connects over an encrypted WebRTC data channel, straight to this machine when the network allows, and must enter the 6-digit code gitui prints for that connection (3 tries) before anything is served; a phone that paired once reconnects without a new code for as long as gitui runs. The rendezvous service only relays the connection setup, and isn't trusted to authenticate anyone: the phone and gitui check the code with [CPace](https://datatracker.ietf.org/doc/draft-irtf-cfrg-cpace/), a password-authenticated key exchange bound to the connection's DTLS fingerprints, in which gitui proves it knows the code before the phone does. A service (or anyone else) that sits in the middle of the connection then fails the check, and a run it watches gives it nothing to test codes against offline; reconnecting proves the saved token both ways, so a device that copies this machine's listing can't accept a phone's reconnection either. The name and listing are public hints, not proof of anything. What remains is guessing the code online, one guess per try, which the 3 tries per connection and the limits on connection requests bound, and anyone who can read the code in this machine's terminal. `GITUI_RENDEZVOUS_URL` (a `ws:` or `wss:` origin) points it at another rendezvous service, e.g. `wrangler dev`'s.

A phone or another computer connected with `--nearby` can only use the repositories opened on the computer running gitui: the one gitui was started with and the recent list (`~/.config/gitui/recent.json`). It can pick from that list, but any other path, typed or in a link, gets a 403, and opening a repository from there doesn't change the list. To reach another repository from the phone, open it on the computer first (`gitui <path>`, or the picker there). Browsers on the computer itself, the hosted app paired over 127.0.0.1 included, can open any repository.

## Development

```sh
bun install
bun run dev [repo-path]   # API on :4777 (bun --watch) + Vite+ dev server with /api proxy
GITUI_ALLOW_ORIGIN=http://localhost:4173 bun run dev   # also accept that origin cross-origin
vp check                  # format, lint, type check
bun test                  # run the tests
bun run build             # type check, build the UI (apps/web/dist/) and bundle the CLI (apps/cli/dist/)
bun apps/cli/bin/gitui.ts # run the CLI from source
scripts/smoke.sh          # start the built bundle with node and check what it serves
```

## Releasing

`.github/workflows/release.yml` publishes `apps/cli` as `@diffiii/gitui` with npm trusted publishing (OIDC, no token), which also adds provenance. To release, bump `version` in `apps/cli/package.json`, commit, then push a matching tag: `git tag v0.1.0 && git push origin v0.1.0`. The workflow fails if the tag isn't `v` + that version.

One-time setup: create a GitHub environment named `npm` (Settings → Environments; optionally restrict it to `v*` tags), then on npmjs.com: package → Settings → Trusted publishing → GitHub Actions, with user `diffiii`, repository `gitui`, workflow `release.yml` and environment `npm`. That page only exists once the package does, so the first version may have to be published by hand (`bun run build`, `cd apps/cli && bun pm pack`, then `npm publish <tarball>` from outside the repo, since npm refuses to run inside it because of the root `devEngines`).

## How it works

- `apps/cli/` (`@diffiii/gitui`): the `gitui` CLI and a [Hono](https://hono.dev) API (`server/`) that shells out to the `git` CLI (`server/git.ts`). It listens on 127.0.0.1 only, rejects requests whose `Host` isn't localhost, and requires an `x-gitui` header on every API request. Cross-origin requests are refused unless they come from an allowed origin (the hosted app, plus any `--allow-origin`), and those must also send the pairing token as a bearer token, so other websites can't drive it. With `--nearby` it also keeps a WebSocket to the rendezvous service over IPv4 and another over IPv6 (with [ws](https://github.com/websockets/ws)) and answers phones' WebRTC offers (`server/nearby/`, with [werift](https://github.com/shinyoshiaki/werift-webrtc)); their requests travel over the data channel to an app of their own, which the authenticated channel lets in. Nearby clients may only use the repositories opened on the computer (the listener's `repoScope` in `server/access.ts`, enforced by `repoGate` in `server/repo-scope.ts`), compared with symlinks resolved. It serves no UI: `/` only points to the hosted app. `bun run build` bundles it into one Node-compatible file (`dist/gitui.js`), which is what the npm package ships, with `apps/cli/README.md` and the root `LICENSE`.
- `apps/web/`: React, Tailwind v4, shadcn/ui and TanStack Query. Status polls every 3s, and every mutation refreshes the repo's queries.
- `packages/shared/` (`@gitui/shared`): API types and connection constants used by both sides.
- Recent repositories are stored in `~/.config/gitui/recent.json`.

## Hosted web app

The git backend needs a real filesystem and the `git` binary, so only the static UI is hosted on Cloudflare, at https://gitui.diffiii.dev (Workers static assets, `apps/web/wrangler.jsonc`). The page talks to the CLI on `http://127.0.0.1:<port>` straight from the browser:

- `gitui` prints and opens a pairing link (`https://…/#port=…&token=…`). The page saves the pairing fragment in localStorage and drops it from the address bar; API calls then send the token as a bearer token.
- Pages from the Vite dev server of `bun run dev` skip pairing and call `/api` same-origin, through the dev server's proxy (`__GITUI_DEV_SERVER__`, which vite.config.ts defines only for the dev server, whatever NODE_ENV says). The production build (`vp build`), which is what gets deployed, never does, so any page served from it pairs, even on localhost.
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

Then open the printed pairing link (`http://localhost:4173/#port=…&token=…`). Any static server for `apps/web/dist` works the same way, with its origin in `GITUI_ALLOW_ORIGIN`. Rebuild after changing the UI; the Vite dev server (`bun run dev`) is always the `dev` connection.

## License

[MIT](LICENSE)
