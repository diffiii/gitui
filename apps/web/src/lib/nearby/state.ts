import { HOST_KEY, hostName, type HostInfo } from "@gitui/shared";

// The pure parts of the nearby connection: the saved host, the session's states, and the list
// of hosts. The app loads this up front, so it must not import the codec (lazy.ts).

/** The host the app is connected to, as saved: its per-run key and display name. */
export interface NearbyHost {
  key: string;
  name: string;
}

/**
 * A nearby session's state (session.ts). `connecting` and `code` block the app, `reconnecting`
 * doesn't: the app stays up while the session comes back. `connected` is `checking` while it
 * makes sure its channel still answers (requests wait meanwhile). `failed` waits for the user,
 * or, when it only ran out of time (`retryOnWake`), for the page to be shown again too; `reload`
 * when only reloading the page can help. `gone`: the
 * rendezvous doesn't list the host's key (gitui quit, or restarted with a new one), so the user
 * picks a computer again. `off` once the session is stopped.
 */
export type NearbyState =
  | {
      kind: "connecting";
      /** Passed on to the code screen, if this attempt asks for the code. */
      notice?: "expired";
    }
  | {
      kind: "code";
      checking: boolean;
      /** After a wrong code. */
      attemptsLeft?: number;
      /** Why the host asks again: the saved resume token didn't work. */
      notice?: "expired";
    }
  | { kind: "connected"; checking: boolean }
  | { kind: "reconnecting"; notice?: "expired" }
  | { kind: "failed"; reason: string; retryOnWake: boolean; reload?: true }
  | { kind: "gone" }
  | { kind: "off" };

/** `value` as a saved NearbyHost, or null if it isn't one. */
export function parseNearbyHost(value: unknown): NearbyHost | null {
  if (typeof value !== "object" || value === null) return null;
  const { key, name } = value as Record<string, unknown>;
  if (typeof key !== "string" || !HOST_KEY.test(key)) return null;
  const trimmed = hostName(name);
  return trimmed === null ? null : { key, name: trimmed };
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
