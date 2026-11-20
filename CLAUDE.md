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
vp build                    # build the frontend into dist/ (`bun run build` = tsc -b && vp build)
```

## Layout

- `server/`: Hono API. `app.ts` holds the routes, `git.ts` wraps the git CLI and parses its
  output, `main.ts` starts the server. Tests live next to the code (`server/*.test.ts`).
- `src/`: React app. `lib/` holds the API client, graph layout and prefs, `components/` the
  views, and `components/ui/` the shadcn components. Unit tests sit next to their module
  (`src/**/*.test.ts`, type-checked by `tsconfig.test.json`).
- `shared/types.ts`: API types used by both sides.
- `bin/gitui.ts`: the `gitui` CLI entry point.

## Conventions

- Run git only through `git()` in `server/git.ts`, with argument arrays and never shell
  strings. User-supplied paths go after `--`.
- Validate ref-like request inputs (branch names, hashes, refs) with `ref()` in
  `server/app.ts`, which rejects anything git could parse as an option.
- Frontend data goes through TanStack Query with keys that start with the repo:
  `[repo, "status"]`, `[repo, "log", ...]`. Repo mutations use `useGitMutation` from
  `src/lib/repo.tsx`, which invalidates `[repo]` when it settles and toasts errors.
- Prefs (`src/lib/prefs.ts`) and URL state (`src/App.tsx`) are external stores read with
  `useSyncExternalStore`. Don't use effects to sync or derive state.
- Add shadcn components under `src/components/ui`.
- Tests: don't import `src/lib/prefs.ts`, because it touches `window` at import time. Server
  tests build repos with the helpers in `server/test-repo.ts`, which isolate git from the
  global and system config, set the identity per repo and delete the temp dirs on exit.

## Commits

Conventional commits, with a subject line only and no body, e.g. `fix(server): ...`,
`feat(history): ...`, `test: ...`.
