import { spawn } from "node:child_process";

/** The command that opens a URL in the default browser on this platform. */
const OPENER: readonly [string, ...string[]] =
  process.platform === "darwin"
    ? ["open"]
    : process.platform === "win32"
      ? ["rundll32", "url.dll,FileProtocolHandler"]
      : ["xdg-open"];

/**
 * Opens `url` with `opener`. No shell: the pairing link's `&` would split a cmd.exe command line.
 * Detached and left to run on its own, unlike the git processes, which end with the request that
 * started them. A missing opener (no xdg-open on a headless machine) is reported through
 * `onError`, not thrown: Node would otherwise end gitui over the unhandled 'error' event.
 */
export function openBrowser(
  url: string,
  onError: (error: Error) => void,
  opener: readonly [string, ...string[]] = OPENER,
) {
  const [cmd, ...args] = opener;
  try {
    spawn(cmd, [...args, url], { stdio: "ignore", detached: true })
      .on("error", onError)
      .unref();
  } catch (e) {
    // Node throws some errnos (a bad argument, EAGAIN) synchronously instead.
    onError(e instanceof Error ? e : new Error(String(e)));
  }
}
