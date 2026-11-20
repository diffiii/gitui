import { parsePairing } from "@gitui/shared";
import { useQuery } from "@tanstack/react-query";
import { Link2, LoaderCircle, Terminal, Unplug } from "lucide-react";
import { useState } from "react";
import { CenteredScreen } from "@/components/CenteredScreen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getConfig } from "@/lib/api";
import {
  connectionStatus,
  retryWhileUnreachable,
  setPairing,
  useConnection,
  type ConnectionStatus,
} from "@/lib/connection";

/** Renders the app once gitui answers; until then, in the hosted app, how to connect to it. */
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
    case "unpaired":
    case "rejected":
      return <PairScreen rejected={status.kind === "rejected"} />;
    case "connecting":
    case "unreachable":
      return <UnreachableScreen status={status} />;
  }
}

const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">{children}</code>
);

function PairScreen({ rejected }: { rejected: boolean }) {
  const [link, setLink] = useState("");
  const [invalid, setInvalid] = useState(false);

  return (
    <CenteredScreen
      icon={Link2}
      title="Connect to gitui"
      description={
        <>
          {rejected && "gitui didn't accept the saved pairing. "}
          Open the link gitui printed in your terminal, or paste it here.
        </>
      }
    >
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
          autoFocus
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
    </CenteredScreen>
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

/** Header button that forgets the pairing; renders nothing outside the hosted app. */
export function DisconnectButton() {
  const connection = useConnection();
  if (connection.kind !== "paired") return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" onClick={() => setPairing(null)}>
          <Unplug />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Disconnect from gitui on port {connection.pairing.port}</TooltipContent>
    </Tooltip>
  );
}
