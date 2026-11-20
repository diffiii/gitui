# gitui

A lazygit-inspired git client that runs in your browser on localhost.

- **Changes**: staged and unstaged files as trees ([@pierre/trees](https://www.npmjs.com/package/@pierre/trees)). Stage, unstage or discard from the row menu (right-click, or the row button); double-click a file to toggle it. Commit or amend with ⌘↵.
- **History**: commit graph across all branches or just the current one, with commit details, a tree of changed files and syntax-highlighted diffs ([@pierre/diffs](https://diffs.com)).
- **Branches**: local and remote branches. Checkout (double-click), create, delete, and see each branch's log.
- Fetch, pull (`--ff-only`) and push from the header. Push sets an upstream when there isn't one.
- Unified or split diffs, and light, dark or system theme.

## Usage

```sh
bun install
vp build                  # build the frontend into apps/web/dist/
cd apps/cli && bun link   # puts `gitui` on your PATH

gitui                     # open the repository picker
gitui .                   # open the repository containing the current directory
gitui ~/code/x -p 5000 --no-open
gitui --hosted            # use the hosted app instead of the local build (no `vp build` needed)
```

On start, gitui also prints a pairing link to the hosted app at https://gitui.diffiii.dev. The link carries the port and a pairing token (kept in `~/.config/gitui/token`; delete it to rotate the token), so a browser stays paired across restarts. `--allow-origin <origin>` (repeatable) lets another web app origin pair too, e.g. a self-hosted copy or a local build.

## Development

```sh
bun run dev [repo-path]   # API on :4777 (bun --watch) + Vite+ dev server with /api proxy
GITUI_ALLOW_ORIGIN=http://localhost:5173 bun run dev   # also accept that origin cross-origin
vp check                  # format, lint, type check
bun test                  # run the tests
```

## How it works

- `apps/cli/`: the `gitui` CLI and a [Hono](https://hono.dev) API (`server/`) that shells out to the `git` CLI (`server/git.ts`). It listens on 127.0.0.1 only, rejects requests whose `Host` isn't localhost, and requires an `x-gitui` header on every API request. Cross-origin requests are refused unless they come from an allowed origin (the hosted app, plus any `--allow-origin`), and those must also send the pairing token as a bearer token, so other websites can't drive it.
- `apps/web/`: React, Tailwind v4, shadcn/ui and TanStack Query. Status polls every 3s, and every mutation refreshes the repo's queries.
- `packages/shared/` (`@gitui/shared`): API types and connection constants used by both sides.
- Recent repositories are stored in `~/.config/gitui/recent.json`.

## Hosted web app

The git backend needs a real filesystem and the `git` binary, so only the static UI is hosted on Cloudflare, at https://gitui.diffiii.dev (Workers static assets, `apps/web/wrangler.jsonc`). The page talks to the CLI on `http://127.0.0.1:<port>` straight from the browser:

- `gitui --hosted` prints and opens a pairing link (`https://…/#port=…&token=…`). The page saves the pairing fragment in localStorage and drops it from the address bar; API calls then send the token as a bearer token.
- Pages served from localhost (the CLI itself, or `bun run dev`) skip pairing and call `/api` same-origin, as before.
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

To try the hosted mode locally, serve the UI on a non-loopback address. With `<lan-ip>` your machine's LAN IP:

```sh
GITUI_ALLOW_ORIGIN=http://<lan-ip>:5173 bun run --cwd apps/cli dev   # API; prints a pairing link for that origin
cd apps/web && bunx vp dev --host                                      # Vite on all interfaces
```

Then open the printed pairing link (`http://<lan-ip>:5173/#port=…&token=…`). Opening `http://localhost:5173` instead gives the local mode, through Vite's `/api` proxy.
