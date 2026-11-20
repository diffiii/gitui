// The `gitui` command line, parsed without side effects so it can be tested.
import net from "node:net";
import { DEFAULT_PORT, HOSTED_ORIGIN } from "@gitui/shared";
import { parseOrigin } from "../server/access.ts";

export const HELP = `gitui — git in your browser

Usage:
  gitui            start the app with a repository picker
  gitui <path>     open the repository containing <path> (e.g. \`gitui .\`)

By default gitui serves only the API and opens the hosted app (${HOSTED_ORIGIN}),
paired with this machine through the printed link.

Options:
  -p, --port <n>          port to listen on (default ${DEFAULT_PORT})
  --local                 serve the UI bundled with gitui and open it instead (for browsers
                          that block the hosted app from reaching localhost, or offline use)
  --lan [address]         serve the bundled UI on your network, for a phone or another device.
                          The address is an IPv4 address of this machine (default: the default
                          route's, if it is private). Prints a link and QR code and never opens
                          a browser; the session travels over plain HTTP
  --nearby                also list this machine for phones on the same network: they find it
                          on ${HOSTED_ORIGIN} and connect over WebRTC with the
                          code gitui prints. Works with --local, not with --lan
  --name <name>           the name phones see with --nearby (default: this machine's hostname)
  --allow-origin <origin> also let the web app at <origin> call the API (repeatable)
  --no-open               don't open the browser
  -h, --help              show this help`;

/**
 * Which UI gitui serves, and where. `hosted` and `local` listen on 127.0.0.1 and accept the
 * hosted app plus `origins` (`--allow-origin`), and with `nearby` also take phones' connections
 * through the rendezvous service; `lan` serves its own UI only, on `address`, or on an address
 * gitui picks if null.
 */
export type Mode =
  | { kind: "hosted" | "local"; origins: string[]; nearby: Nearby | null }
  | { kind: "lan"; address: string | null };

/** `--nearby`: the name phones see, or null for this machine's hostname. */
export interface Nearby {
  name: string | null;
}

/** The longest `--name`, in characters: enough for a hostname, short enough for a phone. */
export const MAX_NAME_LENGTH = 63;

/** The name `--nearby` uses without `--name`: the hostname, without `.local` (macOS adds it). */
export function hostnameAsName(hostname: string) {
  const name = hostname
    .replace(/\.local$/i, "")
    .replace(/\p{Cc}/gu, "")
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return name || "gitui";
}

export interface Options {
  port: number;
  open: boolean;
  mode: Mode;
  /** The path to open the repository of, if given. */
  target: string | null;
}

/** A command line gitui can't run with; `message` says why. */
export class ArgsError extends Error {}

/** The options in `argv` (without node and the script), or "help" for `-h`/`--help`. */
export function parseArgs(argv: string[]): Options | "help" {
  const options: Options = {
    port: DEFAULT_PORT,
    open: true,
    mode: { kind: "hosted", origins: [], nearby: null },
    target: null,
  };
  let nearby = false;
  let name: string | null = null;
  const notWithLan = (flag: string) =>
    new ArgsError(`${flag} doesn't apply to --lan, which serves its own UI only`);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return "help";
    else if (a === "-p" || a === "--port") {
      const port = Number(argv[++i]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ArgsError(`${a} needs a port number, not ${argv[i] ?? "nothing"}`);
      }
      options.port = port;
    } else if (a === "--no-open") options.open = false;
    else if (a === "--local") {
      if (options.mode.kind === "lan") throw new ArgsError("--local and --lan can't be combined");
      options.mode = { ...options.mode, kind: "local" };
    } else if (a === "--lan") {
      const current = options.mode;
      if (current.kind === "lan") throw new ArgsError("--lan is given twice");
      if (current.kind === "local") throw new ArgsError("--local and --lan can't be combined");
      if (current.origins.length) throw notWithLan("--allow-origin");
      // The address is optional: an IPv4 address after --lan is taken as one, anything else that
      // looks like an address is refused rather than taken as the repository path.
      const next = argv[i + 1] ?? "";
      let address: string | null = null;
      if (net.isIPv4(next)) address = argv[++i];
      else if (net.isIPv6(next) || /^\d+(\.\d+)+$/.test(next)) {
        throw new ArgsError(`--lan takes an IPv4 address of this machine, not ${next}`);
      }
      if (address === "0.0.0.0") {
        throw new ArgsError("--lan needs this machine's address, not 0.0.0.0");
      }
      options.mode = { kind: "lan", address };
    } else if (a === "--nearby") nearby = true;
    else if (a === "--name") {
      // Control characters would let the name rewrite the terminals that print it.
      name = argv[++i]?.trim() ?? "";
      if (!name || name.length > MAX_NAME_LENGTH || /\p{Cc}/u.test(name)) {
        throw new ArgsError(`--name needs a name of 1 to ${MAX_NAME_LENGTH} printable characters`);
      }
    } else if (a === "--allow-origin") {
      if (options.mode.kind === "lan") throw notWithLan(a);
      const origin = parseOrigin(argv[++i]);
      if (!origin) throw new ArgsError(`${a} needs an origin, e.g. http://localhost:5173`);
      options.mode.origins.push(origin);
    } else if (a.startsWith("-")) throw new ArgsError(`Unknown option ${a}\n\n${HELP}`);
    else options.target = a;
  }

  if (options.mode.kind === "lan") {
    if (nearby) throw new ArgsError("--nearby and --lan can't be combined");
  } else if (nearby) options.mode.nearby = { name };
  if (name !== null && !nearby) throw new ArgsError("--name only applies to --nearby");
  return options;
}
