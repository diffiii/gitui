// `gitui --nearby`: lists this machine on the rendezvous service for guests on the same network
// and answers each guest's offer with a GuestSession. The host never makes offers.
//
// It registers twice, over IPv4 and over IPv6, with the same key: the service groups peers by
// public address, and a guest may reach it over either family. Each session belongs to the
// socket its offer came on, which carries all its signals and its `gone`.
import net from "node:net";
import { HOSTED_ORIGIN, hostKey, printable, type SignalData, STUN_URLS } from "@gitui/shared";
import { lockoutLine, newHostSecret, PairingBudget, Tokens } from "./auth.ts";
import type { Fetch } from "./bridge.ts";
import { guardWerift } from "./guard.ts";
import { OfferLimiter } from "./offers.ts";
import { errorLine, type GuestOptions, GuestSession } from "./peer.ts";
import {
  BACKOFF,
  type Family,
  KEEPALIVE,
  RendezvousClient,
  type SocketFactory,
} from "./rendezvous.ts";
import { initialStatus, nextStatus, type StatusEvent, type StatusLine } from "./status.ts";

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

export interface NearbyOptions {
  /** The rendezvous WebSocket URL (@gitui/shared's rendezvousUrl). */
  url: string;
  /** The name guests see. */
  name: string;
  /** Answers authenticated guests' requests: an app built with the nearby listener. */
  fetch: Fetch;
  /** Prints a line; every line comes through `printable` (@gitui/shared), so none is unsafe. */
  log: (line: string) => void;
  /** For tests: how sockets and peer connections open, the pairing budget, and timings. */
  open?: SocketFactory;
  peer?: GuestOptions["peer"];
  pairingBudget?: number;
  backoff?: typeof BACKOFF;
  keepalive?: typeof KEEPALIVE;
  statusDelay?: number;
}

/** Starts listing this machine and answering guests; `stop` ends every connection. */
export function startNearby(options: NearbyOptions) {
  const { url, name, fetch } = options;
  // Lines quote what others sent (errors, names): none may drive the terminal.
  const log = (line: string) => options.log(printable(line));
  const secret = newHostSecret();
  /** What guests see: the service lists this host under it. */
  const key = hostKey(secret);
  const tokens = new Tokens();
  const budget = new PairingBudget({
    limit: options.pairingBudget,
    onLockout: (until) => log(lockoutLine(until)),
  });
  const limiter = new OfferLimiter(budget);
  /** Sessions by socket family and the guest's peer id on it. */
  const sessions = new Map<string, GuestSession>();
  const sessionKey = (family: Family, id: string) => `${family}/${id}`;

  const families = familiesFor(url);
  let status = initialStatus(families);
  const lines: Record<StatusLine, () => string> = {
    visible: () => {
      const list = families.filter((f) => status.visible.includes(f)).map((f) => `IPv${f}`);
      return `Nearby: visible as '${name}' (${list.join(", ")}) on this network — open ${HOSTED_ORIGIN} on your phone`;
    },
    unreachable: () => `Nearby: can't reach the rendezvous service at ${url}, retrying`,
    lost: () => "Nearby: lost the rendezvous service, reconnecting",
    reconnected: () => "Nearby: reconnected to the rendezvous service",
    "no-room-hosts": () =>
      "Nearby: too many computers on this network use gitui nearby already, retrying",
    "no-room-sockets": () =>
      "Nearby: the rendezvous service still holds this computer's earlier connections, retrying",
  };
  const report = (event: StatusEvent) => {
    const [next, line] = nextStatus(status, event);
    status = next;
    if (status.phase !== "starting") clearTimeout(statusTimer);
    if (line) log(lines[line]());
  };
  const statusTimer = setTimeout(
    () => report({ type: "timeout" }),
    options.statusDelay ?? STATUS_DELAY,
  );

  /** Runs `fn` about guest `id`; an error of ours there ends its session, not the process. */
  const forGuest = (family: Family, id: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      const line = errorLine(e);
      const session = sessions.get(sessionKey(family, id));
      if (session) session.close(line);
      else log(line);
    }
  };

  const clients = families.map((family) => {
    const client: RendezvousClient = new RendezvousClient({
      url,
      family,
      name,
      secret,
      open: options.open,
      backoff: options.backoff,
      keepalive: options.keepalive,
      events: {
        welcome() {
          report({ type: "welcome", family });
        },
        down() {
          // Guests still signaling on this socket can't reach this host any more: the service
          // gives the new socket a new id.
          for (const [id, session] of [...sessions]) {
            if (id.startsWith(`${family}/`) && !session.authenticated) session.close();
          }
          report({ type: "down", family });
        },
        signal(from, data) {
          forGuest(family, from, () => {
            if (data.kind === "offer") offer(client, from, data);
            else if (data.kind === "candidate") {
              sessions.get(sessionKey(family, from))?.addCandidate(data.offerId, data.candidate);
            }
          });
        },
        // A guest keeps its socket while connected. A closed tab sends nothing on the data
        // channel, whose end WebRTC only notices after ICE consent expires (about 30s); `gone`
        // comes at once. Peer ids are the socket's own, so only its sessions are concerned.
        gone(id) {
          forGuest(family, id, () => sessions.get(sessionKey(family, id))?.close());
        },
        // The service's refusals for want of room (MAX_HOSTS and MAX_SOCKETS_PER_KEY in
        // apps/rendezvous/src/network.ts) close the socket, which is retried with backoff.
        error(code, message) {
          if (code === "host-limit") return report({ type: "no-room", why: "hosts" });
          if (code === "key-limit") return report({ type: "no-room", why: "sockets" });
          log(`Nearby: the rendezvous service reported: ${message} (${code})`);
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
    const pending = [...sessions].filter(([id, s]) => id !== at && !s.authenticated).length;
    const admission = limiter.admit(pending, resume === true);
    if (!admission.ok) {
      // Said, so the guest needn't wait for an answer that won't come, unless refusals came too
      // often.
      if (admission.tell) client.send(from, { kind: "refused", offerId, reason: admission.reason });
      if (admission.line) log(admission.line);
      return;
    }
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
      budget,
      log,
      peer: options.peer,
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
