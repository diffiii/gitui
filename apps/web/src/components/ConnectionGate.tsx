import { AUTH_CODE_DIGITS, parsePairing } from "@gitui/shared";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  CircleAlert,
  KeyRound,
  Laptop,
  LoaderCircle,
  Radar,
  RotateCw,
  Terminal,
  Unplug,
} from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { CenteredScreen } from "@/components/CenteredScreen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getConfig } from "@/lib/api";
import {
  connectionStatus,
  retryWhileUnreachable,
  setNearbyHost,
  setPairing,
  useConnection,
  useDisconnect,
  type ConnectionStatus,
} from "@/lib/connection";
import { rendezvous } from "@/lib/nearby/rendezvous";
import type { NearbySession } from "@/lib/nearby/session";
import type { NearbyState } from "@/lib/nearby/state";

/**
 * Renders the app once gitui answers; until then, in the hosted app, how to connect to it: a
 * computer nearby, or gitui on this one.
 */
export function ConnectionGate({ children }: { children: React.ReactNode }) {
  const connection = useConnection();
  const config = useQuery({
    queryKey: ["config"],
    queryFn: getConfig,
    enabled: connection.kind === "paired",
    ...retryWhileUnreachable,
  });

  const status = connectionStatus(connection, config);
  switch (status.kind) {
    case "connected":
      return children;
    case "nearby":
      return <NearbyGate session={status.session}>{children}</NearbyGate>;
    case "unpaired":
      return <ConnectScreen />;
    case "rejected":
      return <ConnectScreen notice="gitui didn't accept the saved pairing." />;
    case "connecting":
    case "unreachable":
      return <UnreachableScreen status={status} />;
  }
}

/**
 * The app once the nearby session is connected, and while it reconnects, under a banner; until
 * then, the session's progress, its code screen, or why it failed.
 */
function NearbyGate({ session, children }: { session: NearbySession; children: React.ReactNode }) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const name = session.host.name;
  switch (state.kind) {
    case "connected":
    case "reconnecting":
      // The same tree either way, so the app doesn't remount when the banner comes and goes.
      return (
        <>
          {state.kind === "reconnecting" && <ReconnectingBanner host={name} />}
          {children}
        </>
      );
    // The app moves to another connection before it stops this session.
    case "off":
      return null;
    case "connecting":
      return (
        <CenteredScreen icon={Laptop} title={name} description="Connecting…">
          <div className="flex flex-col items-center gap-4">
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
            <ChooseAnotherButton />
          </div>
        </CenteredScreen>
      );
    case "code":
      return <CodeScreen session={session} state={state} />;
    case "gone":
      return (
        <ConnectScreen
          notice={`${name} isn't on this network any more. If gitui restarted there, pick it again and enter its new code.`}
        />
      );
    case "failed":
      return (
        <CenteredScreen icon={CircleAlert} title={name} description={state.reason}>
          <div className="flex flex-col gap-2">
            {state.reload ? (
              <Button size="lg" onClick={() => location.reload()}>
                <RotateCw />
                Reload
              </Button>
            ) : (
              <Button size="lg" onClick={session.retry}>
                <RotateCw />
                Try again
              </Button>
            )}
            <ChooseAnotherButton />
          </div>
        </CenteredScreen>
      );
  }
}

const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">{children}</code>
);

/** Forgets the nearby host, back to the list. */
const ChooseAnotherButton = () => (
  <Button variant="ghost" size="lg" onClick={() => setNearbyHost(null)}>
    Choose another computer
  </Button>
);

/**
 * How to connect the hosted app: a computer nearby, or the pairing link of gitui on this one.
 * `notice`: why the app is back here (the last connection ended), said first.
 */
function ConnectScreen({ notice }: { notice?: React.ReactNode }) {
  return (
    <CenteredScreen
      icon={Radar}
      title="Connect to gitui"
      description={
        <>
          {notice && <>{notice} </>}
          Computers on this network running <Code>gitui --nearby</Code> show up here.
        </>
      }
    >
      <NearbyHosts />
      <section className="mt-8 border-t pt-6">
        <h2 className="mb-1 px-1 text-sm font-medium">gitui on this computer?</h2>
        <p className="mb-3 px-1 text-xs text-muted-foreground">
          Run <Code>npx @diffiii/gitui@latest</Code> (or <Code>bunx</Code>) in a terminal, then open
          the link it prints, or paste it here.
        </p>
        <PairLinkForm />
      </section>
    </CenteredScreen>
  );
}

function NearbyHosts() {
  const client = rendezvous();
  const { status, hosts } = useSyncExternalStore(client.subscribe, client.getSnapshot);
  if (hosts.length > 0) {
    return (
      <ul className="divide-y overflow-hidden rounded-lg border" aria-label="Computers nearby">
        {hosts.map((host) => (
          <li key={host.key}>
            <button
              type="button"
              className="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-muted active:bg-muted"
              onClick={() => setNearbyHost({ key: host.key, name: host.name })}
            >
              <Laptop className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">{host.name}</span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
    );
  }
  if (status === "open") {
    return (
      <div className="space-y-2 rounded-lg border p-4 text-center text-sm text-muted-foreground">
        <p>
          No computers found on this network. Run <Code>npx @diffiii/gitui@latest --nearby</Code> on
          your computer.
        </p>
        <p className="text-xs">A VPN or iCloud Private Relay can hide it.</p>
      </div>
    );
  }
  return (
    <p className="flex items-center justify-center gap-2 rounded-lg border p-4 text-sm text-muted-foreground">
      <LoaderCircle className="size-4 shrink-0 animate-spin" />
      {status === "connecting"
        ? "Looking for computers on this network…"
        : "Can't reach the rendezvous server. Retrying…"}
    </p>
  );
}

function CodeScreen({
  session,
  state,
}: {
  session: NearbySession;
  state: Extract<NearbyState, { kind: "code" }>;
}) {
  const [code, setCode] = useState("");
  const { checking, attemptsLeft, notice } = state;
  return (
    <CenteredScreen
      icon={KeyRound}
      title={session.host.name}
      description={
        notice === "expired"
          ? "This device's session with gitui ended. Enter the code gitui printed in your terminal."
          : "Enter the code gitui printed in your computer's terminal."
      }
    >
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setCode("");
          void session.submitCode(code);
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
      <div className="mt-4 flex justify-center">
        <ChooseAnotherButton />
      </div>
    </CenteredScreen>
  );
}

/**
 * Says the nearby session is coming back, over the app, without getting in its way. It fades in
 * late, so the usual quick reconnect doesn't flash it.
 */
function ReconnectingBanner({ host }: { host: string }) {
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+3.5rem)] z-50 flex justify-center px-4"
    >
      <div className="flex max-w-full animate-in items-center gap-2 rounded-full border bg-background/95 px-3 py-1.5 text-xs shadow-md backdrop-blur fade-in fill-mode-backwards delay-300 duration-300">
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
        <span className="truncate">Reconnecting to {host}…</span>
      </div>
    </div>
  );
}

/** The pairing link of gitui on this computer, pasted. */
function PairLinkForm() {
  const [link, setLink] = useState("");
  const [invalid, setInvalid] = useState(false);

  return (
    <>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const next = parsePairing(link.trim());
          setInvalid(!next);
          if (next) setPairing(next);
        }}
      >
        <Input
          value={link}
          onChange={(e) => {
            setLink(e.target.value);
            setInvalid(false);
          }}
          placeholder={`${location.origin}/#port=…&token=…`}
          aria-invalid={invalid}
          className="font-mono"
        />
        <Button type="submit" disabled={!link.trim()}>
          Connect
        </Button>
      </form>
      {invalid && (
        <p className="mt-2 px-1 text-xs text-destructive">
          That isn't a gitui link. Copy the whole link, including the part after #.
        </p>
      )}
    </>
  );
}

/** Shown while the CLI hasn't answered. It fades in late, so a fast first answer doesn't flash it. */
function UnreachableScreen({
  status: { kind, port },
}: {
  status: Extract<ConnectionStatus, { port: number }>;
}) {
  return (
    <CenteredScreen
      className="animate-in fade-in fill-mode-backwards delay-300 duration-300"
      icon={Terminal}
      title="Start gitui on your computer"
      description={
        <>
          This page works with the gitui CLI running on your machine. Run{" "}
          <Code>npx @diffiii/gitui@latest</Code> (or <Code>bunx</Code>) in a terminal.
        </>
      }
    >
      <ul className="list-disc space-y-2 rounded-lg border p-4 pl-8 text-xs text-muted-foreground">
        <li>
          If your browser asks to let this site access apps and devices on your local network, allow
          it.
        </li>
        <li>
          Safari may block connections to localhost. If it never connects, add <Code>--local</Code>{" "}
          and use the page it opens instead.
        </li>
      </ul>
      <div className="mt-4 flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-2">
          <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
          <span className="truncate">
            {kind === "connecting"
              ? `Connecting to gitui on port ${port}…`
              : `Can't reach gitui on port ${port}. Retrying…`}
          </span>
        </span>
        <Button variant="link" size="xs" className="px-0" onClick={() => setPairing(null)}>
          Use another link
        </Button>
      </div>
    </CenteredScreen>
  );
}

/** Header button that forgets the pairing or nearby host; renders nothing outside the hosted app. */
export function DisconnectButton() {
  const connected = useDisconnect();
  if (!connected) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Disconnect"
          className="touch-target"
          onClick={connected.disconnect}
        >
          <Unplug />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Disconnect from {connected.target}</TooltipContent>
    </Tooltip>
  );
}
