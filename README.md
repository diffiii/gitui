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
```

## Development

```sh
bun run dev [repo-path]   # API on :4777 (bun --watch) + Vite+ dev server with /api proxy
vp check                  # format, lint, type check
bun test                  # run the tests
```

## How it works

- `apps/cli/`: the `gitui` CLI and a [Hono](https://hono.dev) API (`server/`) that shells out to the `git` CLI (`server/git.ts`). It listens on 127.0.0.1 only, rejects requests whose `Host` isn't localhost, and requires an `x-gitui` header on every API request, so other websites can't drive it.
- `apps/web/`: React, Tailwind v4, shadcn/ui and TanStack Query. Status polls every 3s, and every mutation refreshes the repo's queries.
- `packages/shared/` (`@gitui/shared`): API types used by both sides.
- Recent repositories are stored in `~/.config/gitui/recent.json`.

The git backend needs a real filesystem and the `git` binary, so it can't run on Cloudflare Workers. Only the static UI could be hosted there.
