interface ImportMetaEnv {
  /** Origin of the nearby rendezvous Worker, e.g. `ws://127.0.0.1:8787` for `wrangler dev`. */
  readonly VITE_GITUI_RENDEZVOUS_URL?: string;
}

/** True only on the Vite dev server (vite.config.ts), never in a build. */
declare const __GITUI_DEV_SERVER__: boolean;
