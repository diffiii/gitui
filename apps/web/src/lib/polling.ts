/** How often an open diff or file is refetched, so edits made outside gitui show up. */
export const POLL_MS = 3000;
/** Past this many characters a payload is refetched every SLOW_POLL_MS instead. */
export const LARGE_PAYLOAD = 256 * 1024;
export const SLOW_POLL_MS = 15_000;

/**
 * The refetch interval for a payload of `chars` characters (none before the first load). A big
 * diff or file costs a git process, a transfer (a WebRTC round trip over nearby) and a parse on
 * every refetch, and it rarely changes every 3 s.
 */
export const pollInterval = (chars = 0) => (chars > LARGE_PAYLOAD ? SLOW_POLL_MS : POLL_MS);
