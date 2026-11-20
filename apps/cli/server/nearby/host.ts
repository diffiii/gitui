// `gitui --nearby`: lists this machine on the rendezvous service for guests on the same network
// and answers each guest's offer with a GuestSession. The host never makes offers.
import { HOSTED_ORIGIN, RENDEZVOUS_PATH, STUN_URLS } from "@gitui/shared";
import type { Fetch } from "./bridge.ts";
import { GuestSession } from "./peer.ts";
import { RendezvousClient } from "./rendezvous.ts";

/** The rendezvous service; GITUI_RENDEZVOUS_URL replaces it (e.g. with `wrangler dev`'s). */
export const RENDEZVOUS_ORIGIN = "wss://rendezvous.gitui.diffiii.dev";

/**
 * Brute-force limits: every offer gets a fresh code and AUTH_ATTEMPTS tries, so offers are
 * capped, both those still waiting for their code and those per minute.
 */
export const MAX_PENDING = 4;
export const MAX_OFFERS_PER_MINUTE = 12;

/**
 * The rendezvous URL for `origin`, a ws: or wss: origin (GITUI_RENDEZVOUS_URL, if set), or null
 * if it isn't one.
 */
export function rendezvousUrl(origin = RENDEZVOUS_ORIGIN): string | null {
  const url = URL.parse(origin);
  const valid = (url?.protocol === "ws:" || url?.protocol === "wss:") && url.origin === origin;
  return valid ? origin + RENDEZVOUS_PATH : null;
}

/** `text` without control characters, which would let a remote string drive the terminal. */
const printable = (text: string) => text.replace(/\p{Cc}/gu, "");

export interface NearbyOptions {
  /** The rendezvous WebSocket URL (rendezvousUrl). */
  url: string;
  /** The name guests see. */
  name: string;
  /** Answers authenticated guests' requests: an app built with the nearby listener. */
  fetch: Fetch;
  log: (line: string) => void;
}

/** Starts listing this machine and answering guests; `stop` ends every connection. */
export function startNearby({ url, name, fetch, log }: NearbyOptions) {
  const sessions = new Map<string, GuestSession>();
  /** When the offers of the last minute arrived. */
  const offerTimes: number[] = [];
  let welcomed = false;
  let down = false;
  let limited = false;

  const client = new RendezvousClient(url, name, {
    welcome() {
      if (!welcomed) {
        log(`Nearby: visible as '${name}' on this network — open ${HOSTED_ORIGIN} on your phone`);
      } else if (down) log("Nearby: reconnected to the rendezvous service");
      welcomed = true;
      down = false;
    },
    down() {
      // Guests still signaling can't reach this host any more: the service gives it a new id.
      for (const session of [...sessions.values()]) if (!session.authenticated) session.close();
      if (!down) {
        log(
          welcomed
            ? "Nearby: lost the rendezvous service, reconnecting"
            : `Nearby: can't reach the rendezvous service at ${url}, retrying`,
        );
      }
      down = true;
    },
    signal(from, data) {
      if (data.kind === "offer") offer(from, data.sdp);
      else if (data.kind === "candidate") sessions.get(from)?.addCandidate(data.candidate);
    },
    // A guest keeps its socket while connected. A closed tab sends nothing on the data channel,
    // whose end WebRTC only notices after ICE consent expires (about 30s); `gone` comes at once.
    gone(id) {
      sessions.get(id)?.close();
    },
    error(message) {
      log(`Nearby: the rendezvous service reported: ${printable(message)}`);
    },
  });

  function offer(from: string, offerSdp: string) {
    const now = Date.now();
    while (offerTimes.length && offerTimes[0] <= now - 60_000) offerTimes.shift();
    const pending = [...sessions].filter(([id, s]) => id !== from && !s.authenticated).length;
    if (pending >= MAX_PENDING || offerTimes.length >= MAX_OFFERS_PER_MINUTE) {
      if (!limited) log("Nearby: ignoring connection requests, too many at once");
      limited = true;
      return;
    }
    limited = false;
    offerTimes.push(now);
    // A new offer from the same guest replaces its connection.
    sessions.get(from)?.close();
    const session: GuestSession = new GuestSession({
      offerSdp,
      stunUrls: STUN_URLS,
      signal: (data) => client.send(from, data),
      fetch,
      log,
      onEnd: () => {
        if (sessions.get(from) === session) sessions.delete(from);
      },
    });
    sessions.set(from, session);
  }

  client.start();
  return {
    stop() {
      client.stop();
      for (const session of [...sessions.values()]) session.close();
    },
  };
}
