# gitui

A lazygit-inspired git client that runs in the browser on localhost. A Bun + Hono API shells
out to the `git` CLI; a React 19 + TanStack Query + shadcn/ui frontend talks to it over `/api`.

## Commands

```sh
bun install                 # install (--frozen-lockfile to match bun.lock exactly)
bun run dev [repo-path]     # API on :4777 (bun --watch) + Vite+ dev server with /api proxy
bun test                    # bun:test; server tests run against real temp repos
./node_modules/.bin/tsc -b  # type check every tsconfig project
vp check                    # format, lint (type-aware), type check
bun run build               # tsc -b, build apps/web, bundle the CLI into apps/cli/dist (+ dist/web)
cd apps/web && bun run deploy  # build and deploy the hosted UI to Cloudflare (needs wrangler login)
cd apps/rendezvous && bun run dev  # nearby rendezvous Worker on :8787 (wrangler dev)
scripts/smoke.sh            # run the built CLI with node (hosted and --local) and probe it
```

## Layout

Bun workspaces monorepo (`apps/*`, `packages/*`).

- `apps/cli/` (`@diffiii/gitui`, published to npm): the `gitui` bin (`bin/gitui.ts`) and the
  Hono API in `server/`. `app.ts` holds the routes, `git.ts` wraps the git CLI and parses its
  output, `main.ts` starts the server (`@hono/node-server`), serving the UI directory it's given
  with `uiSecurityHeaders` (`bin/gitui.ts` passes `dist/web` only with `--local` and `--lan`;
  by default the hosted app is the UI), `bin/args.ts` parses the command line, `dev.ts` is the
  dev API entry, `lan.ts` picks the `--lan` address. `server/nearby/` is `--nearby`, the host
  side of `@gitui/shared`'s nearby protocol: `rendezvous.ts` (one `ws` socket, pinned to IPv4
  or IPv6, with pings and reconnects), `peer.ts` (one guest: answer, trickle, CPace or resume
  check from `auth.ts`), `bridge.ts` (HTTP over the data channel, pure and unit-tested),
  `host.ts` (wires them up: two sockets, sessions bound to theirs), `guard.ts` (survives
  werift's unhandled rejections on malformed SCTP packets; werift callbacks go through
  `isolate`) and `webrtc.ts`, the only file that imports werift. `bun run build`
  (`scripts/build.ts`) bundles `bin/gitui.ts` for Node into `dist/gitui.js`, copies
  `apps/web/dist` to `dist/web` (`scripts/local-ui.ts` adds the `LOCAL_UI_META` tag to that copy
  only, never to `apps/web/dist`, which is the hosted app, and leaves `_headers` out) and the root `LICENSE` into the package; with `README.md` that is all the package ships, with no runtime dependencies.
  Code in `bin/` and `server/` must run on Node too: no `Bun.*` APIs outside tests, `dev.ts`
  and `test-repo.ts` (a lint rule enforces it). Tests live next to the code (`server/*.test.ts`).
- `apps/web/` (`@gitui/web`): React app. `src/lib/` holds the API client, graph layout and
  prefs, `src/components/` the views, and `src/components/ui/` the shadcn components. Unit
  tests sit next to their module (`src/**/*.test.ts`, type-checked by `tsconfig.test.json`).
  `@/` maps to `apps/web/src`. A page from the dev server (`import.meta.env.DEV`, which `main.tsx`
  passes to `initConnection`) is the `dev` connection and calls its own `/api`, which
  `vite.config.ts` proxies to the dev API (`GITUI_PORT`, default 4777); any other page, whatever
  the host, is the hosted app: `src/lib/connection.ts` holds its pairing with the CLI on
  127.0.0.1 and where requests go (its store reads `window` lazily; `initConnection` does the
  startup wiring), and `ConnectionGate` gates the app until the CLI answers. Its `nearby` kind
  is a `gitui --nearby` found through the rendezvous: `src/lib/nearby/` holds the guest
  (`createSession` in `session.ts` is the state machine, with its dependencies injected; the
  connection opens one per nearby host in `update()`, and `apiTransport` sends requests over its
  data channel; `peer.ts` loads CPace lazily from `@gitui/shared/nearby-pake`; `state.ts` and
  `tokens.ts` are its pure parts). `wrangler.jsonc` builds the repo (its `build` command,
  with the production rendezvous) and deploys `dist/` as Cloudflare Workers static assets, with the `_headers` file that a `vite.config.ts` plugin writes into the
  build from `hostedHeadersFile` (its CSP follows `VITE_GITUI_RENDEZVOUS_URL`), on the custom
  domain `gitui.diffiii.dev` (`HOSTED_ORIGIN`).
- `apps/rendezvous/` (`@gitui/rendezvous`): the "nearby" rendezvous Worker (protocol in
  `packages/shared/src/nearby.ts`). `src/route.ts` checks the upgrade and Origin and names the
  caller's network with an HMAC keyed by the `NETWORK_KEY_SECRET` secret (500 without it),
  `src/network.ts` decides what the object does (hello, signal routing, `gone`, the host list
  once per key, and the socket, host and message limits) over plain socket records, and
  `src/rendezvous.ts` adapts it to the hibernating Durable Object (one per network),
  `scripts/e2e.ts` checks it
  all against `wrangler dev`. Worker code is type-checked with `@cloudflare/workers-types`, tests
  and scripts with bun's.
- `packages/shared/` (`@gitui/shared`): API types and the connection contract (default port,
  client header, hosted origin, loopback hosts, pairing links) and the UI's security headers
  (`headers.ts`, with the hosted app's `_headers` file), used by both sides, imported as `@gitui/shared`. The nearby
  protocol: `nearby.ts` (the contract and its docs), `nearby-codec.ts` (every check on what
  crosses its wires, used by the Worker, the CLI and the web app alike: messages are rebuilt
  with only the contract's fields, so a new field goes there) and `nearby-pake.ts` (CPace on
  ristretto255 for the code and HMAC proofs both ways for resume tokens, pure and synchronous,
  with `@noble/curves` and `@noble/hashes`, which the CLI bundles). Its public functions are
  only in the `@gitui/shared/nearby-pake` entry (`pake.ts`), not in `@gitui/shared`, so the
  Worker and the web app's main chunk carry no curve code.
- Root: `scripts/dev.ts` (runs both apps), `scripts/smoke.sh` (runs the built bundle with node
  in both modes and checks what it serves; CI and release run it), `vite.config.ts` (workspace
  fmt/lint/type check config, `defaultPackage` points `vp dev`/`vp build` at `apps/web`),
  `tsconfig.json` (project references to every package), `.github/workflows/release.yml`
  (publishes the CLI to npm on `v*` tags matching its version, via trusted publishing).

## Conventions

- Run git only through `git()` in `apps/cli/server/git.ts`, with argument arrays and never
  shell strings. User-supplied paths go after `--`.
- Validate ref-like request inputs (branch names, hashes, refs) with `ref()` in
  `apps/cli/server/app.ts`, which rejects anything git could parse as an option.
- `/api/*` access policy lives in `apps/cli/server/access.ts`, keyed by the `Listener`: the
  `x-gitui` header always. `loopback`: localhost `Host`; cross-origin callers only from
  `allowedOrigins`, with CORS headers and the pairing token (`loadToken` in `server/config.ts`)
  as a bearer token. `lan` (`--lan`): `Host` names the listen address (hostnames only, ports
  aren't checked), no cross-origin callers, and the per-run session cookie that
  `/pair?key=<per-run secret>` sets. `nearby`: requests from an authenticated data channel,
  through `nearby/bridge.ts`, which gives them the Host `NEARBY_HOST`. Don't add checks in
  routes or `main.ts`.
- Each listener also has a `repoScope`: `loopback` is `any`; `lan` and `nearby` (other devices)
  are `opened`, i.e. only the `initialRepo` and the recent list, compared as realpaths, read per
  request. Every repo path a request names goes through `repoGate` (`server/repo-scope.ts`): the `repo`
  middleware and `/open`, which only records repos in the recent list for `any`. A refusal is a
  403 `{ error, code: REPO_NOT_OPENED }`. New routes that take a repo path must use the gate.
  Server tests pass `configDir` to `createApp` so they never touch the real recent list.
- Frontend data goes through TanStack Query with keys that start with the repo:
  `[repo, "status"]`, `[repo, "log", ...]`. Repo mutations use `useGitMutation` from
  `apps/web/src/lib/repo.tsx`, which invalidates `[repo]` when it settles and toasts errors.
- Prefs (`apps/web/src/lib/prefs.ts`), URL state (`apps/web/src/lib/url.ts`: repo, view, view
  options and the open detail) and media queries (`apps/web/src/lib/media.ts`) are external stores read with
  `useSyncExternalStore`. Don't use effects to sync or derive state.
- List/detail views go through `ListDetail` (`apps/web/src/components/ListDetail.tsx`) with
  `useListChoice` (`apps/web/src/lib/listChoice.ts`): side by side, or stacked on narrow
  screens, where opening a detail pushes a history entry.
- Put each dependency in the package that uses it (in `apps/cli` as devDependencies, since
  they're bundled); shared tooling (typescript, vite-plus, @types/bun) stays at the root.
- Add shadcn components under `apps/web/src/components/ui` (run `shadcn` from `apps/web`).
- Tests: don't import `apps/web/src/lib/prefs.ts`, because it touches `window` at import time.
  Server tests build repos with the helpers in `apps/cli/server/test-repo.ts`, which isolate
  git from the global and system config, set the identity per repo and delete the temp dirs on
  exit.

## Commits

Conventional commits, with a subject line only and no body, e.g. `fix(server): ...`,
`feat(history): ...`, `test: ...`.
