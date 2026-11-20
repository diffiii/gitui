// The `gitui` command line, parsed without side effects so it can be tested.
import { DEFAULT_PORT, HOSTED_ORIGIN, hostName, MAX_NAME_LENGTH, toHostName } from "@gitui/shared";
import { parseOrigin } from "../server/access.ts";

export const HELP = `gitui — git in your browser

Usage:
  gitui            start the app with a repository picker
  gitui <path>     open the repository containing <path> (e.g. \`gitui .\`)

gitui serves the API on this machine and opens the hosted app (${HOSTED_ORIGIN}),
paired with this machine through the printed link.

Options:
  -p, --port <n>          port to listen on (default ${DEFAULT_PORT})
  --nearby                also list this machine for phones on the same network: they find it
                          on ${HOSTED_ORIGIN} and connect over WebRTC with the
                          code gitui prints. Desktop Safari, which blocks the hosted app from
                          reaching localhost, can pick this computer from the same list
  --name <name>           the name phones see with --nearby (default: this machine's hostname)
  --allow-origin <origin> also let the web app at <origin> call the API (repeatable)
  --no-open               don't open the browser
  -h, --help              show this help`;

/** `--nearby`: the name phones see, or null for this machine's hostname. */
export interface Nearby {
  name: string | null;
}

/**
 * The name `--nearby` uses without `--name`: the hostname, without `.local` (macOS adds it),
 * made into one the rendezvous takes (hostName), or "gitui" if nothing is left of it.
 */
export function hostnameAsName(hostname: string) {
  return toHostName(hostname.replace(/\.local$/i, "")) ?? "gitui";
}

export interface Options {
  port: number;
  open: boolean;
  /** Web apps besides the hosted one that may call the API (`--allow-origin`). */
  origins: string[];
  /** `--nearby`, or null without it. */
  nearby: Nearby | null;
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
    origins: [],
    nearby: null,
    target: null,
  };
  let nearby = false;
  let name: string | null = null;

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
    else if (a === "--nearby") nearby = true;
    else if (a === "--name") {
      // The rendezvous refuses other names (and the CLI would reconnect forever); control and
      // bidi characters would also let the name rewrite or disguise the lines that print it.
      name = hostName(argv[++i] ?? "");
      if (name === null) {
        throw new ArgsError(
          `--name needs a name of 1 to ${MAX_NAME_LENGTH} characters, without control or bidi characters`,
        );
      }
    } else if (a === "--allow-origin") {
      const origin = parseOrigin(argv[++i]);
      if (!origin) throw new ArgsError(`${a} needs an origin, e.g. http://localhost:5173`);
      options.origins.push(origin);
    } else if (a.startsWith("-")) throw new ArgsError(`Unknown option ${a}\n\n${HELP}`);
    else options.target = a;
  }

  if (nearby) options.nearby = { name };
  if (name !== null && !nearby) throw new ArgsError("--name only applies to --nearby");
  return options;
}
