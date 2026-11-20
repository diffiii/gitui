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
vp build                    # build apps/web into apps/web/dist (`bun run build` adds tsc -b)
cd apps/web && bun run deploy  # build and deploy the hosted UI to Cloudflare (needs wrangler login)
```

## Layout

Bun workspaces monorepo (`apps/*`, `packages/*`).

- `apps/cli/` (`@gitui/cli`): the `gitui` bin (`bin/gitui.ts`) and the Hono API in `server/`.
  `app.ts` holds the routes, `git.ts` wraps the git CLI and parses its output, `main.ts` starts
  the server and serves `apps/web/dist` in production. Tests live next to the code
  (`server/*.test.ts`).
- `apps/web/` (`@gitui/web`): React app. `src/lib/` holds the API client, graph layout and
  prefs, `src/components/` the views, and `src/components/ui/` the shadcn components. Unit
  tests sit next to their module (`src/**/*.test.ts`, type-checked by `tsconfig.test.json`).
  `@/` maps to `apps/web/src`. Served from a non-loopback host it is the hosted app:
  `src/lib/connection.ts` holds the pairing with the CLI and where requests go (its store reads
  `window` lazily; `initConnection` does the startup wiring), and `ConnectionGate` gates the app
  until the CLI answers. `wrangler.jsonc` and `public/_headers` deploy `dist/` as Cloudflare
  Workers static assets on the custom domain `gitui.diffiii.dev` (`HOSTED_ORIGIN`).
- `packages/shared/` (`@gitui/shared`): API types and the connection contract (default port,
  client header, hosted origin, loopback hosts, pairing links) used by both sides, imported as
  `@gitui/shared`.
- Root: `scripts/dev.ts` (runs both apps), `vite.config.ts` (workspace fmt/lint/type check
  config, `defaultPackage` points `vp dev`/`vp build` at `apps/web`), `tsconfig.json`
  (project references to every package).

## Conventions

- Run git only through `git()` in `apps/cli/server/git.ts`, with argument arrays and never
  shell strings. User-supplied paths go after `--`.
- Validate ref-like request inputs (branch names, hashes, refs) with `ref()` in
  `apps/cli/server/app.ts`, which rejects anything git could parse as an option.
- `/api/*` access policy lives in `apps/cli/server/access.ts`: localhost `Host` and the
  `x-gitui` header always; cross-origin callers only from `allowedOrigins`, with CORS headers
  and the pairing token (`loadToken` in `server/config.ts`) as a bearer token. Don't add checks in routes.
- Frontend data goes through TanStack Query with keys that start with the repo:
  `[repo, "status"]`, `[repo, "log", ...]`. Repo mutations use `useGitMutation` from
  `apps/web/src/lib/repo.tsx`, which invalidates `[repo]` when it settles and toasts errors.
- Prefs (`apps/web/src/lib/prefs.ts`) and URL state (`apps/web/src/App.tsx`) are external
  stores read with `useSyncExternalStore`. Don't use effects to sync or derive state.
- Put each dependency in the package that uses it; shared tooling (typescript, vite-plus,
  @types/bun) stays at the root.
- Add shadcn components under `apps/web/src/components/ui` (run `shadcn` from `apps/web`).
- Tests: don't import `apps/web/src/lib/prefs.ts`, because it touches `window` at import time.
  Server tests build repos with the helpers in `apps/cli/server/test-repo.ts`, which isolate
  git from the global and system config, set the identity per repo and delete the temp dirs on
  exit.

## Commits

Conventional commits, with a subject line only and no body, e.g. `fix(server): ...`,
`feat(history): ...`, `test: ...`.
