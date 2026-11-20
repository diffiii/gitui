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
gitui --nearby            # also let a phone on your network find and connect to this machine
```

| Option                    | Description                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `-p, --port <n>`          | Port to listen on (default 4777, or the next free one)                                                                 |
| `--nearby`                | Also list this machine for phones on the same network, which connect over WebRTC once they enter the code gitui prints |
| `--name <name>`           | The name phones see with `--nearby` (default: the hostname)                                                            |
| `--allow-origin <origin>` | Also let the web app at `<origin>` pair (repeatable)                                                                   |
| `--no-open`               | Don't open the browser                                                                                                 |
| `-h, --help`              | Show the help                                                                                                          |

Needs `git`, and Node.js 22.1 or later or Bun. The bin is a Node script, so `bunx` runs it with Node when Node is installed; `bunx --bun` runs it with Bun. The pairing token is kept in `~/.config/gitui/token` (delete it to rotate it). Desktop Safari blocks the hosted app from reaching 127.0.0.1: run `gitui --nearby` and pick this computer from the nearby list instead, with iCloud Private Relay off (it makes Safari look like it is on another network).

`--nearby` lists this machine on a rendezvous service for devices behind the same public IP; https://gitui.diffiii.dev on a phone there shows it. The phone connects over an encrypted WebRTC data channel and must enter the 6-digit code gitui prints for that connection (3 tries) before anything is served; once paired, it reconnects without a new code while gitui runs. The rendezvous service only relays the connection setup and isn't trusted with authentication: the code is checked with CPace, a password-authenticated key exchange bound to the connection, in which gitui proves it knows the code first, so the only attack on the code is guessing it online: 3 tries per connection, and 10 in any 10 minutes in all. After those, gitui pairs no new device until the oldest try is 10 minutes old, and says so; paired devices still reconnect.

Source, issues and docs: https://github.com/diffiii/gitui. MIT licensed.
