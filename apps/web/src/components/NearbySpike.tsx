import { AUTH_CODE_DIGITS, CLIENT_HEADER, type HostInfo } from "@gitui/shared";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  CircleAlert,
  KeyRound,
  Laptop,
  LoaderCircle,
  Radar,
  type LucideIcon,
} from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { CenteredScreen } from "@/components/CenteredScreen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AppConfig } from "@/lib/api";
import type { GuestPeer } from "@/lib/nearby/peer";
import { rendezvous } from "@/lib/nearby/rendezvous";
import {
  connect,
  disconnect,
  submitCode,
  useNearbySession,
  type NearbySession,
} from "@/lib/nearby/session";

/**
 * Spike of the nearby connection at `/nearby`: lists the gitui hosts on this network, connects to
 * one over WebRTC, takes its code and round-trips a couple of API requests over the channel.
 */
export function NearbySpike() {
  const session = useNearbySession();
  switch (session.kind) {
    case "idle":
      return <HostList />;
    case "connecting":
      return (
        <HostScreen icon={Laptop} host={session.host} description="Connecting…">
          <div className="flex flex-col items-center gap-4">
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
            <Button variant="outline" className="w-full" onClick={disconnect}>
              Cancel
            </Button>
          </div>
        </HostScreen>
      );
    case "code":
      return <CodeScreen session={session} />;
    case "connected":
      return <ConnectedScreen host={session.host} peer={session.peer} />;
    case "failed":
      return (
        <HostScreen icon={CircleAlert} host={session.host} description={session.reason}>
          <Button variant="outline" className="w-full" onClick={disconnect}>
            Back
          </Button>
        </HostScreen>
      );
  }
}

const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">{children}</code>
);

function HostList() {
  const client = rendezvous();
  const { status, hosts } = useSyncExternalStore(client.subscribe, client.getSnapshot);
  return (
    <CenteredScreen
      icon={Radar}
      title="gitui nearby"
      description="Computers running gitui on this network show up here."
    >
      {hosts.length > 0 ? (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {hosts.map((host) => (
            <li key={host.id}>
              <button
                type="button"
                className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-muted active:bg-muted"
                onClick={() => void connect(host)}
              >
                <Laptop className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium">{host.name}</span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      ) : status === "open" ? (
        <p className="rounded-lg border p-4 text-center text-sm text-muted-foreground">
          No gitui found on this network. Run <Code>npx @diffiii/gitui@latest --nearby</Code> on
          your computer.
        </p>
      ) : (
        <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          {status === "connecting"
            ? "Looking for gitui on this network…"
            : "Can't reach the rendezvous server. Retrying…"}
        </p>
      )}
    </CenteredScreen>
  );
}

function HostScreen({
  icon,
  host,
  description,
  children,
}: {
  icon: LucideIcon;
  host: HostInfo;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <CenteredScreen icon={icon} title={host.name} description={description}>
      {children}
    </CenteredScreen>
  );
}

function CodeScreen({ session }: { session: Extract<NearbySession, { kind: "code" }> }) {
  const [code, setCode] = useState("");
  const { host, checking, attemptsLeft } = session;
  return (
    <HostScreen
      icon={KeyRound}
      host={host}
      description="Enter the code gitui printed in your computer's terminal."
    >
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setCode("");
          void submitCode(code);
        }}
      >
        <Input
          autoFocus
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={AUTH_CODE_DIGITS}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          placeholder={"0".repeat(AUTH_CODE_DIGITS)}
          aria-label="Code"
          aria-invalid={attemptsLeft !== undefined}
          disabled={checking}
          // 16px, so iOS doesn't zoom into the field.
          className="h-10 text-center font-mono text-base tracking-[0.3em] md:text-base"
        />
        <Button
          type="submit"
          size="lg"
          className="h-10"
          disabled={checking || code.length !== AUTH_CODE_DIGITS}
        >
          {checking && <LoaderCircle className="animate-spin" />}
          Connect
        </Button>
      </form>
      {attemptsLeft !== undefined && (
        <p role="alert" className="mt-2 px-1 text-xs text-destructive">
          That code didn't match. {attemptsLeft} {attemptsLeft === 1 ? "attempt" : "attempts"} left.
        </p>
      )}
      <Button variant="link" size="xs" className="mt-4 px-1" onClick={disconnect}>
        Cancel
      </Button>
    </HostScreen>
  );
}

interface Timed<T> {
  status: number;
  body: T;
  bytes: number;
  ms: number;
}

/** GET `path` over the channel, timing the round trip up to the last byte. */
async function timedGet<T>(peer: GuestPeer, path: string): Promise<Timed<T>> {
  const start = performance.now();
  const res = await peer.fetch(path, { headers: { [CLIENT_HEADER]: "1" } });
  const bytes = await res.arrayBuffer();
  const ms = Math.round(performance.now() - start);
  const body = JSON.parse(new TextDecoder().decode(bytes)) as T;
  return { status: res.status, body, bytes: bytes.byteLength, ms };
}

function ConnectedScreen({ host, peer }: { host: HostInfo; peer: GuestPeer }) {
  // gcTime 0: the answers belong to this connection, so they go when it does.
  const config = useQuery({
    queryKey: ["nearby", host.id, "config"],
    queryFn: () => timedGet<AppConfig>(peer, "/api/config"),
    gcTime: 0,
  });
  const repo = config.data?.body.recent[0];
  const [wantStatus, setWantStatus] = useState(false);
  const status = useQuery({
    queryKey: ["nearby", host.id, "status", repo],
    queryFn: () =>
      timedGet<unknown>(peer, `/api/repo/status?${new URLSearchParams({ repo: repo! })}`),
    enabled: wantStatus && repo !== undefined,
    gcTime: 0,
  });

  return (
    <HostScreen icon={Laptop} host={host} description="Connected over WebRTC.">
      <div className="flex flex-col gap-4">
        <Probe title="GET /api/config" query={config} />
        <Button
          variant="outline"
          disabled={!repo || status.isFetching}
          onClick={() => (wantStatus ? void status.refetch() : setWantStatus(true))}
        >
          {repo ? `Fetch the status of ${repo.split("/").at(-1)}` : "No recent repo to fetch"}
        </Button>
        {wantStatus && <Probe title="GET /api/repo/status" query={status} />}
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1"
            disabled={config.isFetching}
            onClick={() => void config.refetch()}
          >
            Fetch config again
          </Button>
          <Button variant="ghost" className="flex-1" onClick={disconnect}>
            Disconnect
          </Button>
        </div>
      </div>
    </HostScreen>
  );
}

/** Shows at most this much of a response body. */
const PREVIEW_CHARS = 1500;

function Probe({
  title,
  query,
}: {
  title: string;
  query: { data?: Timed<unknown>; error: Error | null; isFetching: boolean };
}) {
  const { data, error, isFetching } = query;
  const json = data ? JSON.stringify(data.body, null, 2) : "";
  return (
    <section className="rounded-lg border text-xs" aria-busy={isFetching}>
      <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="font-mono font-medium">{title}</span>
        <span className="text-muted-foreground" data-testid="timing">
          {isFetching
            ? "…"
            : data && `${data.status} · ${data.ms} ms · ${(data.bytes / 1024).toFixed(1)} KB`}
        </span>
      </header>
      {error ? (
        <p className="px-3 py-2 text-destructive">{error.message}</p>
      ) : (
        <pre className="max-h-60 overflow-auto px-3 py-2 font-mono break-all whitespace-pre-wrap">
          {json.length > PREVIEW_CHARS ? `${json.slice(0, PREVIEW_CHARS)}\n…` : json}
        </pre>
      )}
    </section>
  );
}
