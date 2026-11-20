import { HOST_KEY, hostName, type HostInfo } from "@gitui/shared";

// The pure parts of the nearby connection: what the session store's states are, and the
// decisions it makes. session.ts runs them against the network; tests run them as they are.

/** The host the app is connected to, as saved: its per-run key and display name. */
export interface NearbyHost {
  key: string;
  name: string;
}

/**
 * The page's connection to its nearby host (session.ts). `off` while the app's connection isn't
 * nearby. `connecting` and `code` block the app, `reconnecting` doesn't: the app stays up while
 * the session comes back. `failed` waits for the user.
 */
export type NearbyState =
  | { kind: "off" }
  | { kind: "connecting"; host: NearbyHost }
  | {
      kind: "code";
      host: NearbyHost;
      checking: boolean;
      /** After a wrong code. */
      attemptsLeft?: number;
      /** Why the host asks again: its resume token stopped working, or it restarted. */
      notice?: "expired" | "restarted";
    }
  | { kind: "connected"; host: NearbyHost }
  | { kind: "reconnecting"; host: NearbyHost }
  | { kind: "failed"; host: NearbyHost; reason: string };

/** `value` as a saved NearbyHost, or null if it isn't one. */
export function parseNearbyHost(value: unknown): NearbyHost | null {
  if (typeof value !== "object" || value === null) return null;
  const { key, name } = value as Record<string, unknown>;
  if (typeof key !== "string" || !HOST_KEY.test(key)) return null;
  const valid = hostName(name);
  return valid === null ? null : { key, name: valid };
}

/**
 * One entry per host key, in the order keys first appear: a CLI registers over IPv4 and IPv6,
 * and overlaps its old socket when it reconnects. The last entry for a key wins, since the
 * rendezvous lists sockets oldest first and the newest is the one most likely alive.
 */
export function dedupeHosts(hosts: HostInfo[]): HostInfo[] {
  const byKey = new Map<string, HostInfo>();
  for (const host of hosts) {
    byKey.delete(host.key);
    byKey.set(host.key, host);
  }
  const order = [...new Set(hosts.map((h) => h.key))];
  return order.map((key) => byKey.get(key)!);
}

/**
 * Where `host` is among the listed hosts. A CLI makes a new key each run, so a host that is gone
 * while another with the same name is listed most likely restarted: its tokens are gone too,
 * and the guest has to pair with the new run.
 */
export function findHost(
  hosts: HostInfo[],
  host: NearbyHost,
):
  | { kind: "listed"; host: HostInfo }
  | { kind: "restarted"; host: HostInfo }
  | { kind: "missing" } {
  const listed = hosts.findLast((h) => h.key === host.key);
  if (listed) return { kind: "listed", host: listed };
  const renamed = hosts.filter((h) => h.name === host.name);
  // Two computers with the same name: there is no telling which one it was.
  return renamed.length === 1 ? { kind: "restarted", host: renamed[0]! } : { kind: "missing" };
}

/** How a new data channel opens: `resume` with a saved token, else `auth` with a code. */
export const opening = (token: string | null): { t: "resume"; token: string } | { t: "auth" } =>
  token ? { t: "resume", token } : { t: "auth" };

/**
 * After the host turned a `resume` away: ask for the code on the same channel while the host
 * still takes attempts (a refused first `resume` costs none), else on a new one (the host
 * closes after its last failure).
 */
export const afterRejectedResume = (attemptsLeft: number): "ask-code" | "reopen" =>
  attemptsLeft > 0 ? "ask-code" : "reopen";
