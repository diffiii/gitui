// A guard against werift (0.26.0; 0.27.0 and 0.28.0 alike) letting a malformed packet from a
// peer kill the process. Its SCTP receive path (`handleData`) is async and nothing awaits it, so
// whatever throws there is an unhandled rejection, which ends a Node process. A guest needs no
// code to get there, only a DTLS handshake. Known ways in: a DATA_CHANNEL_ACK for a stream it
// never opened ("channel not found"), a message with an unknown payload protocol id (a bare
// Error), an SCTP packet with a bad checksum or an unknown chunk type, and a truncated chunk (a
// RangeError from Buffer). werift has dropped the packet by then, so the process can go on.
//
// So the guard takes the unhandled rejections thrown under `handleData`, which names that path
// bundled or not. Our own code never throws there: webrtc.ts rethrows anything our callbacks
// throw on a task of its own, where it crashes the process as an uncaught exception. Every other
// unhandled rejection is rethrown from the listener, which crashes the process with it just as
// if there were no listener.

/** The function name of each "    at …" line of `stack`; null for anonymous frames. */
export function stackFunctions(stack: string): (string | null)[] {
  return stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .map((line) => {
      // Node: "at Class.name [as alias] (file:line:col)", "at file:line:col" when anonymous.
      // Bun: "at name (file:line:col)", "at <anonymous> (file:line:col)".
      const call = /^at (?:async )?(.+?) \(/.exec(line)?.[1];
      if (!call || call === "<anonymous>") return null;
      return call.replace(/ \[as [^\]]+\]$/, "").replace(/^.*\./, "");
    });
}

/** werift's SCTP receive path, which every inbound packet goes through. */
const SCTP_RECEIVE = "handleData";

/** Whether `reason` was thrown by werift while it handled a packet from a peer. */
export function isWeriftPeerError(reason: unknown): reason is Error {
  return (
    reason instanceof Error &&
    typeof reason.stack === "string" &&
    stackFunctions(reason.stack).includes(SCTP_RECEIVE)
  );
}

/**
 * Takes werift's peer errors (isWeriftPeerError) until the returned function is called, calling
 * `onCaught` for each. Every other unhandled rejection still crashes the process.
 */
export function guardWerift(onCaught: (error: Error) => void): () => void {
  const listener = (reason: unknown) => {
    if (!isWeriftPeerError(reason)) throw reason;
    onCaught(reason);
  };
  process.on("unhandledRejection", listener);
  return () => void process.off("unhandledRejection", listener);
}

/**
 * `fn`, for werift to call: an error it throws is rethrown on a task of its own, so it never
 * surfaces inside werift (where the guard would take it for werift's) and crashes as usual.
 */
export function isolate<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  return (...args) => {
    try {
      fn(...args);
    } catch (error) {
      setImmediate(() => {
        throw error;
      });
    }
  };
}
