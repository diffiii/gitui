// The nearby code that lazy.ts loads on demand, in a chunk of its own: everything that reads
// the protocol (the codec, and with it Effect), so a page that never goes nearby never loads it.
export { rendezvous } from "./rendezvous.ts";
export { nearbySession } from "./session.ts";
