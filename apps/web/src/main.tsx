import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./lib/prefs"; // applies the theme before first render
import App from "./App.tsx";
import { ConnectionGate } from "./components/ConnectionGate.tsx";
import { NearbySpike } from "./components/NearbySpike.tsx";
import { initConnection } from "./lib/connection.ts";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
});

// `/nearby` is a standalone spike of connecting over WebRTC; it doesn't use the app's connection.
const nearby = location.pathname === "/nearby";
if (!nearby) initConnection(queryClient);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {nearby ? (
        <NearbySpike />
      ) : (
        <ConnectionGate>
          <App />
        </ConnectionGate>
      )}
    </QueryClientProvider>
  </StrictMode>,
);
