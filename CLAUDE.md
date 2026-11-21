# gitui

A lazygit-inspired git client that runs in the browser on localhost. An Effect API (Effect 4's
HttpRouter, on Node) shells out to the `git` CLI; a React 19 + TanStack Query + shadcn/ui
frontend talks to it over `/api`.

## Commands

```sh
bun install                 # install (--frozen-lockfile to match bun.lock exactly)
bun run dev [repo-path]     # API on :4777 (bun --watch) + Vite+ dev server with /api proxy
bun test                    # bun:test; server tests run against real temp repos
./node_modules/.bin/tsc -b  # type check every tsconfig project
bun run typecheck           # the same with Effect's diagnostics (effect-tsgo), as CI and release do
vp check                    # format, lint (type-aware), type check
bun run build               # tsc -b, build apps/web, bundle the CLI into apps/cli/dist
cd apps/web && bun run deploy  # build and deploy the hosted UI to Cloudflare (needs wrangler login)
cd apps/rendezvous && bun run dev  # nearby rendezvous Worker on :8787 (wrangler dev)
scripts/smoke.sh            # run the built CLI with node and probe it (RUNTIME=bun for Bun)
```

## Layout

Bun workspaces monorepo (`apps/*`, `packages/*`).

- `apps/cli/` (`@diffiii/gitui`, published to npm): the `gitui` bin (`bin/gitui.ts`, an Effect
  program run with `NodeRuntime.runMain`) and the API in `server/`, on Effect. `app.ts` holds
  the routes (Effect's `HttpRouter`, a table in `API_ROUTES`; `createApp` returns them as a
  layer, and `toFetch` makes a layer a scoped web handler for the nearby bridge and tests),
  `git.ts` runs the git CLI (Effect's `ChildProcessSpawner`,
  each git in a process group of its own) and parses its output, `main.ts` serves the app with
  `NodeHttpServer` on 127.0.0.1, with only a plain-text pointer to the hosted app at `/` (a
  route of its own, outside the API's access checks): the CLI serves no UI. `bin/args.ts` parses the command line (pure), `bin/open.ts` opens the browser, `dev.ts` is the dev API
  entry. `server/nearby/` is `--nearby`, the host
  side of `@gitui/shared`'s nearby protocol: `rendezvous.ts` (one `ws` socket, pinned to IPv4
  or IPv6, kept up by a fiber that pings and reconnects), `peer.ts` (one guest: answer,
  trickle, CPace or resume check from `auth.ts`; its waits are fibers its close interrupts),
  `bridge.ts` (HTTP over the data channel, one fiber per request, unit-tested),
  `host.ts` (`startNearby`, a scoped Effect that wires them up: two sockets, sessions bound to
  theirs; closing the scope ends them all), `guard.ts` (survives
  werift's unhandled rejections on malformed SCTP packets; werift callbacks go through
  `isolate`) and `webrtc.ts`, the only file that imports werift. `bun run build`
  (`scripts/build.ts`) bundles `bin/gitui.ts` for Node into `dist/gitui.js` and copies the root
  `LICENSE` into the package; with `README.md` that is all the package ships, with no runtime
  dependencies.
  Code in `bin/` and `server/` must run on Node too (22.15 or later: Effect's Node server turns on strict
  Content-Length checks, which older 22.x releases get wrong): no `Bun.*` APIs outside tests, `dev.ts`
  and `test-repo.ts` (a lint rule enforces it). Tests live next to the code (`server/*.test.ts`).
- `apps/web/` (`@gitui/web`): React app. `src/lib/` holds the API client, graph layout and
  prefs, `src/components/` the views, and `src/components/ui/` the shadcn components. Unit
  tests sit next to their module (`src/**/*.test.ts`, type-checked by `tsconfig.test.json`).
  `@/` maps to `apps/web/src`. A page from the dev server (`__GITUI_DEV_SERVER__`, defined by `vite.config.ts`, which `main.tsx`
  passes to `initConnection`) is the `dev` connection and calls its own `/api`, which
  `vite.config.ts` proxies to the dev API (`GITUI_PORT`, default 4777); any other page, whatever
  the host, is the hosted app: `src/lib/connection.ts` holds its pairing with the CLI on
  127.0.0.1 and where requests go (its store reads `window` lazily; `initConnection` does the
  startup wiring), and `ConnectionGate` gates the app until the CLI answers. Its `nearby` kind
  is a `gitui --nearby` found through the rendezvous: `src/lib/nearby/` holds the guest
  (`createSession` in `session.ts` is the state machine, with its dependencies injected; the
  connection opens one per nearby host in `update()`, and `apiTransport` sends requests over its
  data channel; `peer.ts` loads CPace lazily from `@gitui/shared/nearby-pake`; `state.ts` and
  `tokens.ts` are its pure parts). The codec (`@gitui/shared/nearby-codec`), and with it
  Effect, stays out of the main chunk:
  only `lazy.ts`, `state.ts` and `errors.ts` load up front, and `lazy.ts` imports the rest
  (`client.ts`) on demand, for the connect screen's host list or a nearby connection, whose
  session it wraps until it loads. The repo views (`RepoViews.tsx`, with `@pierre/diffs` and
  `@pierre/trees`) load on demand too, from `App.tsx`. A `vite.config.ts` plugin fails the build
  if the main chunk has Effect, the codec, or those two in it. `wrangler.jsonc` builds the repo (its `build` command,
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
  client header, hosted origin, loopback hosts, pairing links), used by both sides, and the
  hosted app's `_headers` file (`headers.ts`, which the web build emits), imported as `@gitui/shared`. The nearby
  protocol: `nearby.ts` (the contract and its docs, and the plain helpers: `hostName`,
  `toHostName`, `printable`, `rendezvousUrl`, `sdpFingerprint`), `nearby-codec.ts` (every check
  on what crosses its wires, used by the Worker, the CLI and the web app alike: each message is
  an Effect Schema, decoding keeps only the contract's fields, so a new protocol field goes into
  its schema there and its type in `nearby.ts`, which a type-level assertion keeps equal; its
  errors only name the path and whether it was missing or invalid; it holds only schemas and
  decoders) and `nearby-pake.ts` (CPace on ristretto255 for the code and HMAC proofs both ways
  for resume tokens, pure and synchronous, with `@noble/curves` and `@noble/hashes`, which the
  CLI bundles). The codec is only in the `@gitui/shared/nearby-codec` entry, and the CPace
  functions only in `@gitui/shared/nearby-pake` (`pake.ts`), not in `@gitui/shared`, so code
  that imports the main entry carries no Effect and no curve code.
- Root: `scripts/dev.ts` (runs both apps), `scripts/smoke.sh` (runs the built bundle with node
  in both modes and checks what it serves; CI and release run it), `vite.config.ts` (workspace
  fmt/lint/type check config, `defaultPackage` points `vp dev`/`vp build` at `apps/web`),
  `tsconfig.json` (project references to every package), `.github/workflows/ci.yml`
  (a `check` job and a `test` job on Linux, macOS and Windows, the last not yet a gate; it also
  runs as `workflow_call`) and `.github/workflows/release.yml` (on `v*` tags: checks the tag
  against the version, runs ci.yml, whose Linux `test` leg packs the tested tarball, then a
  `publish` job with only that tarball publishes it to npm via trusted publishing).

## Conventions

- Run git only through `git()` (or `run()`/`gitPatch()`) in `apps/cli/server/git.ts`, with
  argument arrays and never shell strings. User-supplied paths go after `--`.
- CLI code is Effect code: server functions return Effects that fail with typed errors
  (`GitError`, `RepoNotOpenedError`; the app maps them to 400 and 403) and need the Node
  services (`NodeServices.layer`), which the app provides per request. Things that live for a
  while (servers, sockets, the nearby host) are scoped and end with their scope. Code that a
  callback must answer synchronously (socket and werift events, protocol state machines like
  `nearby/auth.ts`) stays plain, and so do pure parsers.
- Validate request bodies and parameters with the schemas in `apps/cli/server/app.ts`; ref-like
  inputs (branch names, hashes, refs) go through `Ref`, which rejects anything git could parse
  as an option, and paths through `FilePath` or `WorkingPath`. Their `withMessage` messages
  (`server/schema-messages.ts`) are the 400s' errors; any other failure is a 500 with a fixed
  message (the cause is logged, never sent). Each route declares its `query` and `body`
  schemas, and `route`/`repoRoute` decode them (after the repo gate) before the answer runs,
  which gets them decoded: routes don't read the request themselves. A body is read only for a
  route with a `body` schema, wants `content-type: application/json` (415) and at most
  `MAX_BODY_BYTES` (413); a repeated query parameter counts by its first value.
- `/api/*` access policy lives in `apps/cli/server/access.ts`, keyed by the `Listener`: the
  `x-gitui` header always. `loopback`: localhost `Host`; cross-origin callers only from
  `allowedOrigins`, with CORS headers and the pairing token (`loadToken` in `server/config.ts`)
  as a bearer token. `nearby`: requests from an authenticated data channel,
  through `nearby/bridge.ts`, which gives them the Host `NEARBY_HOST`. Don't add checks in
  routes or `main.ts`. The checks are router middleware on the API routes (not global, and not
  a test on the URL), so the router's own match decides what they cover; `ROUTER_CONFIG` keeps
  its matching exact, and the middleware refuses paths it would still rewrite or that aren't
  spelled one way (`%`, `;`, `#`, `\`, `//`, or not starting with `/`). Serve and `toFetch`
  with `ROUTER_CONFIG`; `app-guard.test.ts` probes odd spellings, and `main.test.ts` sends some
  over a raw socket. Unknown paths, under `/api/repo` too, fall to the `/api/*` catch-alls.
- Each listener also has a `repoScope`: `loopback` is `any`; `nearby` (other devices) is
  `opened`, i.e. only the `initialRepo` and the recent list, compared as realpaths, read per
  request. Every repo path a request names goes through `repoGate` (`server/repo-scope.ts`): every
  route made with `repoRoute` in `app.ts` and `/open`, which only records repos in the recent
  list for `any`. A `repoRoute` with `lock: true` (every `mutation`, and pull) runs, once its
  inputs are decoded, under `withWriteLock` (`server/lock.ts`: the repo's lock, then one of
  `MAX_WRITES` permits shared by all repos) in a fiber of the server's scope, so a client
  going away doesn't stop git halfway (shutdown and git's timeouts still do). Any other route,
  fetch and push included, stops with its client, git and all. A refusal is a
  403 `{ error, code: REPO_NOT_OPENED }`. New routes that take a repo path must use the gate.
  Server tests pass `configDir` to `createApp` so they never touch the real recent list.
- The hosted page reads a JSON 404 from the API as "this CLI is older than the page" (`api.ts`):
  answer 404 only for routes that don't exist (`notFound` in `app.ts`), never for missing data.
- Frontend data goes through TanStack Query with keys that start with the repo:
  `[repo, "status"]`, `[repo, "log", ...]`. Repo mutations use `useGitMutation` from
  `apps/web/src/lib/repo.tsx`, which invalidates `[repo]` when it settles and toasts errors.
- Prefs (`apps/web/src/lib/prefs.ts`), URL state (`apps/web/src/lib/url.ts`: repo, view, view
  options and the open detail) and media queries (`apps/web/src/lib/media.ts`) are external stores read with
  `useSyncExternalStore`. Don't use effects to sync or derive state.
- List/detail views go through `ListDetail` (`apps/web/src/components/ListDetail.tsx`) with
  `useListChoice` (`apps/web/src/lib/listChoice.ts`): side by side, or stacked on narrow
  screens, where opening a detail pushes a history entry.
- Effect's diagnostics come from `@effect/tsgo` (TypeScript 7 has no JS plugins, so not
  `@effect/language-service`), configured as the `@effect/language-service` plugin in
  `tsconfig.base.json`: an Effect that is never run (`floatingEffect`) is an error, warnings
  don't fail the check, and `unstableApiUsage` is off (the CLI builds on Effect's unstable
  platform modules, pinned exactly). Plain `tsc` ignores the plugin; editors show them only when
  their TypeScript server is `effect-tsgo tsc --lsp --stdio`.
- Put each dependency in the package that uses it (in `apps/cli` as devDependencies, since
  they're bundled); shared tooling (typescript, vite-plus, @types/bun) stays at the root.
  `@effect/tsgo` (`bun run typecheck`) ships its own TypeScript compiler: move it in lockstep
  with `typescript`, to a release built on the same TypeScript version.
- Add shadcn components under `apps/web/src/components/ui` (run `shadcn` from `apps/web`).
- Tests: don't import `apps/web/src/lib/prefs.ts`, because it touches `window` at import time.
  Server tests build repos with the helpers in `apps/cli/server/test-repo.ts`, which isolate
  git from the global and system config, set the identity per repo and delete the temp dirs on
  exit; its `run(effect)` runs an Effect as a Promise with the Node services, `client(layer)`
  (and `testApp()`) sends requests to an app until `removeTempDirs` disposes it, and
  `server/test-scope.ts`'s `startScoped` starts a scoped one (a rendezvous client, a nearby
  host) with a `stop`.

## Commits

Conventional commits, with a subject line only and no body, e.g. `fix(server): ...`,
`feat(history): ...`, `test: ...`.
