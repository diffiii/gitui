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
  --allow-origin <origin> also let the web app at <origin> call the API (repeatable)
  --no-open               don't open the browser
  -h, --help              show this help`;

/**
 * Which UI gitui serves, and where. `hosted` and `local` listen on 127.0.0.1 and accept the
 * hosted app plus `origins` (`--allow-origin`); `lan` serves its own UI only, on `address`, or on
 * an address gitui picks if null.
 */
export type Mode =
  | { kind: "hosted" | "local"; origins: string[] }
  | { kind: "lan"; address: string | null };

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
    mode: { kind: "hosted", origins: [] },
    target: null,
  };
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
      options.mode = { kind: "local", origins: options.mode.origins };
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
    } else if (a === "--allow-origin") {
      if (options.mode.kind === "lan") throw notWithLan(a);
      const origin = parseOrigin(argv[++i]);
      if (!origin) throw new ArgsError(`${a} needs an origin, e.g. http://localhost:5173`);
      options.mode.origins.push(origin);
    } else if (a.startsWith("-")) throw new ArgsError(`Unknown option ${a}\n\n${HELP}`);
    else options.target = a;
  }
  return options;
}
