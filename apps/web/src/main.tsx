import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./lib/prefs"; // applies the theme before first render
import App from "./App.tsx";
import { ConnectionGate } from "./components/ConnectionGate.tsx";
import { initConnection } from "./lib/connection.ts";
import { initNearby } from "./lib/nearby/session.ts";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
});

initConnection(queryClient);
initNearby(queryClient);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConnectionGate>
        <App />
      </ConnectionGate>
    </QueryClientProvider>
  </StrictMode>,
);
