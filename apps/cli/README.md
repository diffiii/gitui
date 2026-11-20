# @diffiii/gitui

A lazygit-inspired git client that runs in your browser: stage and commit changes, browse the commit graph with diffs, manage branches, and fetch, pull or push.

```sh
npx @diffiii/gitui@latest       # Node
bunx @diffiii/gitui@latest      # Bun
```

`gitui` starts a local API on 127.0.0.1 that runs your `git`, then opens the web app at https://gitui.diffiii.dev through a pairing link it prints. The link carries the port and a pairing token, so only that app (and nothing else on the web) can call the API, and the browser stays paired across restarts. Your repositories never leave your machine: the hosted page talks to the CLI straight from the browser.

```sh
gitui                     # open the repository picker
gitui .                   # open the repository containing the current directory
gitui ~/code/x -p 5000 --no-open
gitui --local             # serve the UI bundled in the package instead, on localhost
gitui --lan               # serve the bundled UI on your network, to use from your phone
```

| Option                    | Description                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `-p, --port <n>`          | Port to listen on (default 4777, or the next free one)                                                                            |
| `--local`                 | Serve the bundled UI and open it, for offline use, or browsers that may block the hosted app from reaching localhost (Safari)     |
| `--lan [address]`         | Serve the bundled UI on this IPv4 address (default: the default route's, if private) and print a link and QR code to pair a phone |
| `--allow-origin <origin>` | Also let the web app at `<origin>` pair (repeatable)                                                                              |
| `--no-open`               | Don't open the browser                                                                                                            |
| `-h, --help`              | Show the help                                                                                                                     |

Needs `git`, and Node.js 22.1 or later or Bun. The bin is a Node script, so `bunx` runs it with Node when Node is installed; `bunx --bun` runs it with Bun. The pairing token is kept in `~/.config/gitui/token` (delete it to rotate it).

`--lan` pairs devices with a key made per run, through a link that sets a session cookie. Both travel over plain HTTP, so use it on trusted networks only (home Wi-Fi or a phone hotspot, not public Wi-Fi). Cookies ignore ports, so other web services on the same address receive the session cookie too: only use it on a machine whose other services you trust. It never opens a browser, and only picks a private address by itself.

Source, issues and docs: https://github.com/diffiii/gitui. MIT licensed.
