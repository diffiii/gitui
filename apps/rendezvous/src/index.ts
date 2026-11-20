// The nearby rendezvous Worker: routes each WebSocket at RENDEZVOUS_PATH to the Durable Object of
// its network. It logs nothing; see README.md.
import type { Rendezvous } from "./rendezvous.ts";
import { route } from "./route.ts";

export { Rendezvous } from "./rendezvous.ts";

export interface Env {
  RENDEZVOUS: DurableObjectNamespace<Rendezvous>;
  /** Comma-separated browser origins allowed besides HOSTED_ORIGIN, e.g. a local dev server. */
  ALLOWED_ORIGINS?: string;
}

export default {
  async fetch(request, env) {
    const routed = await route(request, env.ALLOWED_ORIGINS);
    if ("status" in routed) return new Response(routed.message, { status: routed.status });
    return env.RENDEZVOUS.get(env.RENDEZVOUS.idFromName(routed.network)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
