// `gitui --nearby`: lists this machine on the rendezvous service for guests on the same network
// and answers each guest's offer with a GuestSession. The host never makes offers.
//
// It registers twice, over IPv4 and over IPv6, with the same key: the service groups peers by
// public address, and a guest may reach it over either family. Each session belongs to the
// socket its offer came on, which carries all its signals and its `gone`.
import net from "node:net";
import { HOSTED_ORIGIN, type SignalData, STUN_URLS } from "@gitui/shared";
import { newHostKey, Tokens } from "./auth.ts";
import type { Fetch } from "./bridge.ts";
import { guardWerift } from "./guard.ts";
import { GuestSession } from "./peer.ts";
import {
  BACKOFF,
  type Family,
  KEEPALIVE,
  RendezvousClient,
  type SocketFactory,
} from "./rendezvous.ts";

/**
 * Brute-force limits: every offer gets a fresh code and AUTH_ATTEMPTS tries, so offers are
 * capped, both those still waiting for their code and those per minute.
 */
export const MAX_PENDING = 4;
export const MAX_OFFERS_PER_MINUTE = 12;

/** How long the first status line waits for a family that hasn't connected or failed yet. */
export const STATUS_DELAY = 3000;

/** At most one line per this long about packets the werift guard dropped. */
const GUARD_LOG_INTERVAL = 60_000;

/** The IP families to register over: both, unless `url` names an IP address. */
export function familiesFor(url: string): Family[] {
  const host = new URL(url).hostname.replace(/^\[(.*)\]$/, "$1");
  const family = net.isIP(host);
  return family === 4 || family === 6 ? [family] : [4, 6];
}

/**
 * The service's refusals for want of room (MAX_HOSTS and MAX_SOCKETS_PER_KEY in
 * apps/rendezvous/src/network.ts). The socket closes after one and is retried with backoff.
 */
const NO_ROOM = /^Too many (hosts on this network|sockets for this host)$/;

/** `text` without control characters, which would let a remote string drive the terminal. */
const printable = (text: string) => text.replace(/\p{Cc}/gu, "");

export interface NearbyOptions {
  /** The rendezvous WebSocket URL (@gitui/shared's rendezvousUrl). */
  url: string;
  /** The name guests see. */
  name: string;
  /** Answers authenticated guests' requests: an app built with the nearby listener. */
  fetch: Fetch;
  log: (line: string) => void;
  /** For tests: how sockets open, and timings. */
  open?: SocketFactory;
  backoff?: typeof BACKOFF;
  keepalive?: typeof KEEPALIVE;
  statusDelay?: number;
}

/** Starts listing this machine and answering guests; `stop` ends every connection. */
export function startNearby(options: NearbyOptions) {
  const { url, name, fetch, log } = options;
  const key = newHostKey();
  const tokens = new Tokens();
  /** Sessions by socket family and the guest's peer id on it. */
  const sessions = new Map<string, GuestSession>();
  const sessionKey = (family: Family, id: string) => `${family}/${id}`;
  /** When the offers of the last minute arrived. */
  const offerTimes: number[] = [];
  let limited = false;

  // Status: one line once every family connected or failed (or STATUS_DELAY passed), then a
  // line when the last family drops and when one is back. A missing family stays quiet.
  const families = familiesFor(url);
  const visible = new Set<Family>();
  const settled = new Set<Family>();
  let announced = false;
  let lost = false;
  const visibleLine = () => {
    const list = families.filter((f) => visible.has(f)).map((f) => `IPv${f}`);
    return `Nearby: visible as '${name}' (${list.join(", ")}) on this network — open ${HOSTED_ORIGIN} on your phone`;
  };
  const announce = () => {
    if (announced) return;
    announced = true;
    clearTimeout(statusTimer);
    if (visible.size) return log(visibleLine());
    lost = true;
    log(`Nearby: can't reach the rendezvous service at ${url}, retrying`);
  };
  const settle = (family: Family) => {
    settled.add(family);
    if (settled.size === families.length) announce();
  };
  const statusTimer = setTimeout(announce, options.statusDelay ?? STATUS_DELAY);
  let everVisible = false;
  /** Whether the service's lack of room was said since the last welcome. */
  let noRoomSaid = false;

  const clients = families.map((family) => {
    const client: RendezvousClient = new RendezvousClient({
      url,
      family,
      name,
      key,
      open: options.open,
      backoff: options.backoff,
      keepalive: options.keepalive,
      events: {
        welcome() {
          visible.add(family);
          settle(family);
          if (announced && lost) {
            log(everVisible ? "Nearby: reconnected to the rendezvous service" : visibleLine());
          }
          lost = false;
          everVisible = true;
          noRoomSaid = false;
        },
        down() {
          // Guests still signaling on this socket can't reach this host any more: the service
          // gives the new socket a new id.
          for (const [id, session] of [...sessions]) {
            if (id.startsWith(`${family}/`) && !session.authenticated) session.close();
          }
          const was = visible.delete(family);
          settle(family);
          if (announced && was && visible.size === 0 && !lost) {
            lost = true;
            log("Nearby: lost the rendezvous service, reconnecting");
          }
        },
        signal(from, data) {
          if (data.kind === "offer") offer(client, from, data);
          else if (data.kind === "candidate") {
            sessions.get(sessionKey(family, from))?.addCandidate(data.offerId, data.candidate);
          }
        },
        // A guest keeps its socket while connected. A closed tab sends nothing on the data
        // channel, whose end WebRTC only notices after ICE consent expires (about 30s); `gone`
        // comes at once. Peer ids are the socket's own, so only its sessions are concerned.
        gone(id) {
          sessions.get(sessionKey(family, id))?.close();
        },
        error(message) {
          if (NO_ROOM.test(message)) {
            if (!noRoomSaid) {
              log("Nearby: too many computers on this network use gitui nearby already, retrying");
            }
            noRoomSaid = true;
            return;
          }
          log(`Nearby: the rendezvous service reported: ${printable(message)}`);
        },
      },
    });
    return client;
  });

  function offer(
    client: RendezvousClient,
    from: string,
    { offerId, sdp: offerSdp, resume }: Extract<SignalData, { kind: "offer" }>,
  ) {
    const at = sessionKey(client.family, from);
    const now = Date.now();
    while (offerTimes.length && offerTimes[0] <= now - 60_000) offerTimes.shift();
    const pending = [...sessions].filter(([id, s]) => id !== at && !s.authenticated).length;
    const refusal =
      pending >= MAX_PENDING
        ? "busy"
        : offerTimes.length >= MAX_OFFERS_PER_MINUTE
          ? "rate-limited"
          : null;
    if (refusal) {
      // Said, so the guest needn't wait for an answer that won't come.
      client.send(from, { kind: "refused", offerId, reason: refusal });
      if (!limited) log("Nearby: ignoring connection requests, too many at once");
      limited = true;
      return;
    }
    limited = false;
    offerTimes.push(now);
    // A new offer from the same guest replaces its connection.
    sessions.get(at)?.close();
    const session: GuestSession = new GuestSession({
      offerSdp,
      offerId,
      resuming: resume === true,
      stunUrls: STUN_URLS,
      signal: (data) => client.send(from, data),
      fetch,
      tokens,
      log,
      onEnd: () => {
        if (sessions.get(at) === session) sessions.delete(at);
      },
    });
    sessions.set(at, session);
  }

  let lastGuardLog = -Infinity;
  const unguard = guardWerift((error) => {
    if (Date.now() - lastGuardLog < GUARD_LOG_INTERVAL) return;
    lastGuardLog = Date.now();
    const what = printable(error.message) || error.name;
    log(`Nearby: ignored a malformed packet from a device (${what})`);
  });

  for (const client of clients) client.start();
  return {
    key,
    stop() {
      clearTimeout(statusTimer);
      for (const client of clients) client.stop();
      for (const session of [...sessions.values()]) session.close();
      unguard();
    },
  };
}
