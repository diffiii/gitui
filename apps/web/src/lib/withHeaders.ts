import { CLIENT_HEADER } from "@gitui/shared";

/** `init` with the client header every API request carries, and `extra` headers. */
export function withHeaders(init: RequestInit, extra: Record<string, string> = {}): RequestInit {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries({ [CLIENT_HEADER]: "1", ...extra })) {
    headers.set(name, value);
  }
  return { ...init, headers };
}
