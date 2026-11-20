// `@gitui/shared/nearby-pake`: the nearby authentication functions (nearby-pake.ts) that callers
// need, and nothing else. They draw their own scalars and nonces; the variants that take them,
// the CPace primitives (cpace.ts) and the byte helpers stay inside the package. A separate entry,
// so that only code that pairs pulls in the curve code: the main entry (index.ts) doesn't export
// these, and the web app loads this one when a page pairs or resumes.
export {
  guestFinish,
  guestStart,
  type GuestPake,
  hostFinish,
  type HostPake,
  hostRespond,
  resumeAnswer,
  resumeStart,
  resumeVerify,
} from "./nearby-pake.ts";
