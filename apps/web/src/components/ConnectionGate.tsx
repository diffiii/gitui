import { useQuery } from "@tanstack/react-query";
import { Link2, LoaderCircle, Terminal, Unplug, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiError, getConfig } from "@/lib/api";
import { pairingFromLink } from "@/lib/connection";
import { hosted, setPairing, usePairing } from "@/lib/pairing";

const unauthorized = (e: unknown) => e instanceof ApiError && e.kind === "unauthorized";

/** In the hosted app, shows how to connect to the gitui CLI until its API answers. */
export function ConnectionGate({ children }: { children: React.ReactNode }) {
  return hosted ? <HostedGate>{children}</HostedGate> : children;
}

function HostedGate({ children }: { children: React.ReactNode }) {
  const pairing = usePairing();
  const config = useQuery({
    queryKey: ["config"],
    queryFn: getConfig,
    enabled: pairing !== null,
    // Keep trying while gitui isn't running, so the page connects as soon as it starts.
    refetchInterval: (q) => (q.state.error && !unauthorized(q.state.error) ? 2000 : false),
  });

  if (!pairing || unauthorized(config.error)) return <PairScreen rejected={pairing !== null} />;
  if (config.isSuccess) return children;
  if (config.error) return <UnreachableScreen port={pairing.port} error={config.error.message} />;
  return null;
}

function Screen({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="rounded-2xl border bg-muted/50 p-3">
            <Icon className="size-6" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">{children}</code>
);

function PairScreen({ rejected }: { rejected: boolean }) {
  const [link, setLink] = useState("");
  const [invalid, setInvalid] = useState(false);

  return (
    <Screen
      icon={Link2}
      title="Connect to gitui"
      description={
        <>
          {rejected && "gitui didn't accept the saved pairing. "}
          Open the link <Code>gitui --hosted</Code> printed in your terminal, or paste it here.
        </>
      }
    >
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const next = pairingFromLink(link.trim());
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
    </Screen>
  );
}

function UnreachableScreen({ port, error }: { port: number; error: string }) {
  return (
    <Screen
      icon={Terminal}
      title="Start gitui on your computer"
      description={
        <>
          This page works with the gitui CLI running on your machine. Run{" "}
          <Code>gitui --hosted</Code> in a terminal.
        </>
      }
    >
      <ul className="list-disc space-y-2 rounded-lg border p-4 pl-8 text-xs text-muted-foreground">
        <li>
          If your browser asks to let this site access apps and devices on your local network, allow
          it.
        </li>
        <li>
          Safari may block connections to localhost. If it never connects, run <Code>gitui</Code>{" "}
          and use the page it opens instead.
        </li>
      </ul>
      <div className="mt-4 flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-2">
          <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
          <span className="truncate">
            {error}. Retrying on port {port}…
          </span>
        </span>
        <Button variant="link" size="xs" className="px-0" onClick={() => setPairing(null)}>
          Use another link
        </Button>
      </div>
    </Screen>
  );
}

/** Header button that forgets the pairing; renders nothing outside the hosted app. */
export function DisconnectButton() {
  const pairing = usePairing();
  if (!pairing) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" onClick={() => setPairing(null)}>
          <Unplug />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Disconnect from gitui on port {pairing.port}</TooltipContent>
    </Tooltip>
  );
}
