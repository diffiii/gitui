import { expect, test } from "bun:test";
import { fromBase64Url, toBase64Url } from "./bytes.ts";
import { type Fingerprints, sdpFingerprint } from "./nearby.ts";
import {
  guestFinish,
  guestStart,
  guestStartWith,
  hostFinish,
  hostRespond,
  hostRespondWith,
  resumeAnswer,
  resumeStart,
  resumeStartWith,
  resumeVerify,
} from "./nearby-pake.ts";

/** A fingerprint, as sdpFingerprint makes them: bytes n, n + 1, … */
const print = (n: number) =>
  sdpFingerprint(
    "a=fingerprint:sha-256 " +
      Array.from({ length: 32 }, (_, i) => ((i + n) & 0xff).toString(16).padStart(2, "0")).join(
        ":",
      ),
  )!;
const prints: Fingerprints = { guest: print(1), host: print(2) };

/** One whole code exchange; what each step produced. */
function run(guestCode: string, hostCode: string, guestPrints = prints, hostPrints = prints) {
  const start = guestStart(guestCode, guestPrints);
  const answer = hostRespond(hostCode, hostPrints, start.message.y);
  if (!answer) return { answer, confirm: null, accepted: false };
  const confirm = guestFinish(start.state, answer.message);
  const accepted = confirm !== null && hostFinish(answer.state, confirm.confirm);
  return { answer, confirm, accepted };
}

test("CPace: both sides agree on the right code", () => {
  const { confirm, accepted } = run("123456", "123456");
  expect(confirm?.confirm).toMatch(/^[\w-]{43}$/);
  expect(accepted).toBe(true);
});

test("CPace: a wrong code fails at the guest, which then sends no tag", () => {
  const { answer, confirm } = run("123457", "123456");
  expect(answer).not.toBeNull();
  expect(confirm).toBeNull();
});

test("CPace: swapped or tampered fingerprints fail", () => {
  const swapped = { guest: prints.host, host: prints.guest };
  expect(run("123456", "123456", prints, swapped).confirm).toBeNull();
  // A relay that replaced the guest's certificate in the offer: the host sees another one.
  expect(run("123456", "123456", prints, { ...prints, guest: print(9) }).confirm).toBeNull();
});

test("CPace: a transcript mismatch fails", () => {
  const start = guestStart("123456", prints);
  const answer = hostRespond("123456", prints, start.message.y)!;
  // Another share from the host than the one its tag covers.
  const other = hostRespond("123456", prints, start.message.y)!;
  expect(
    guestFinish(start.state, { y: other.message.y, confirm: answer.message.confirm }),
  ).toBeNull();
  // A tag for another run of the guest's.
  const second = guestStart("123456", prints);
  expect(guestFinish(second.state, answer.message)).toBeNull();
  // The host checks the guest's tag against its own run.
  const confirm = guestFinish(start.state, answer.message)!;
  expect(hostFinish(other.state, confirm.confirm)).toBe(false);
  expect(hostFinish(answer.state, confirm.confirm)).toBe(true);
});

test("CPace: the guest rejects a bad host tag, and the host a bad guest tag", () => {
  const start = guestStart("123456", prints);
  const answer = hostRespond("123456", prints, start.message.y)!;
  const flipped = (tag: string) =>
    toBase64Url(fromBase64Url(tag, 32)!.map((b: number, i: number) => (i ? b : b ^ 1)));
  expect(
    guestFinish(start.state, { ...answer.message, confirm: flipped(answer.message.confirm) }),
  ).toBeNull();
  expect(guestFinish(start.state, { ...answer.message, confirm: "short" })).toBeNull();
  // The host's own tag reflected back isn't the guest's.
  expect(hostFinish(answer.state, answer.message.confirm)).toBe(false);
  const confirm = guestFinish(start.state, answer.message)!;
  expect(hostFinish(answer.state, flipped(confirm.confirm))).toBe(false);
  expect(hostFinish(answer.state, "")).toBe(false);
});

test("CPace: invalid shares are refused", () => {
  expect(hostRespond("123456", prints, "short")).toBeNull();
  expect(hostRespond("123456", prints, toBase64Url(new Uint8Array(32)))).toBeNull(); // identity
  const start = guestStart("123456", prints);
  expect(
    guestFinish(start.state, { y: toBase64Url(new Uint8Array(32)), confirm: "A".repeat(43) }),
  ).toBeNull();
});

test("CPace: a fixed scalar gives a reproducible share", () => {
  const a = guestStartWith("123456", prints, 12345n).message.y;
  expect(guestStartWith("123456", prints, 12345n).message.y).toBe(a);
  expect(guestStartWith("123457", prints, 12345n).message.y).not.toBe(a);
});

// Known answers: every value gitui's own constructions derive, for fixed scalars, fingerprints,
// code, token and nonce. Another implementation (or a change here) must produce these exactly;
// the round-trip tests above would still pass with both sides drifting together.
const KNOWN = {
  code: "042917",
  guestScalar: 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefn,
  hostScalar: 0x0fedcba9876543210fedcba9876543210fedcba9876543210fedcba98765432n,
  token: "dG9rZW4tZm9yLWtub3duLWFuc3dlci10ZXN0cy0wMDA",
  nonce: "bm9uY2UtZm9yLWthdHMtMDA",
};

test("known answers: shares and both confirmation tags", () => {
  const start = guestStartWith(KNOWN.code, prints, KNOWN.guestScalar);
  const answer = hostRespondWith(KNOWN.code, prints, start.message.y, KNOWN.hostScalar)!;
  const confirm = guestFinish(start.state, answer.message)!;
  expect({ ya: start.message.y, ...answer.message, guestConfirm: confirm.confirm }).toEqual({
    ya: "bCkWCHMr1pAuqS7h-Dq7PdXvZbjQw_O0S0j8VZPB8Qk",
    t: "pake",
    y: "gAwBw0JOF_bHHvpfI1FwIa4W8SLF4QR8a8rSwPQBpRA",
    confirm: "UnFHhPqFUXWEztnao3HX3LSwtPC1_JKYnkmviFSQHIk",
    guestConfirm: "kk3zZbONEAYxu_TqQ2EpLgwWdgP5bb8PhXid2at4d4Q",
  });
  expect(hostFinish(answer.state, confirm.confirm)).toBe(true);
});

test("known answers: both resume proofs", () => {
  const resume = resumeStartWith(KNOWN.token, prints, KNOWN.nonce);
  const answer = resumeAnswer([KNOWN.token], prints, resume)!;
  expect({ guest: resume.proof, host: answer.message.proof }).toEqual({
    guest: "ogAMQvCq9nw8_zysI-H8SSAWtU86DYV5d7L5nJJt_w0",
    host: "p3XPGIgaRBy3mIvD333XHoQgtYgJn7NpQoV2NAQOkSs",
  });
  expect(resumeVerify(KNOWN.token, prints, resume, answer.message)).toBe(true);
});

const tokens = ["token-one-".padEnd(43, "1"), "token-two-".padEnd(43, "2")];

test("resume: the guest and the host prove the token to each other", () => {
  const resume = resumeStart(tokens[1]!, prints);
  const answer = resumeAnswer(tokens, prints, resume);
  expect(answer?.token).toBe(tokens[1]);
  expect(resumeVerify(tokens[1]!, prints, resume, answer!.message)).toBe(true);
});

test("resume: an impostor host without the token can't prove it", () => {
  const resume = resumeStart(tokens[0]!, prints);
  // It knows no tokens, so it can only guess a proof, or send the guest's own back.
  expect(resumeAnswer([], prints, resume)).toBeNull();
  expect(resumeVerify(tokens[0]!, prints, resume, { proof: resume.proof })).toBe(false);
  expect(resumeVerify(tokens[0]!, prints, resume, { proof: "A".repeat(43) })).toBe(false);
  // A proof made with another token, or for another nonce, doesn't do either.
  const other = resumeAnswer(tokens, prints, resumeStart(tokens[1]!, prints))!;
  expect(resumeVerify(tokens[0]!, prints, resume, other.message)).toBe(false);
});

test("resume: proofs are bound to the connection and the token", () => {
  const resume = resumeStart(tokens[0]!, prints);
  expect(resumeAnswer(tokens, { ...prints, host: print(9) }, resume)).toBeNull();
  expect(resumeAnswer(tokens, { guest: prints.host, host: prints.guest }, resume)).toBeNull();
  expect(resumeAnswer(["unknown".padEnd(43, "x")], prints, resume)).toBeNull();
  // A proof replayed with another nonce fails.
  expect(resumeAnswer(tokens, prints, { ...resume, nonce: "n".repeat(22) })).toBeNull();
  // The host's answer, checked against another connection, fails too.
  const answer = resumeAnswer(tokens, prints, resume)!;
  expect(resumeVerify(tokens[0]!, { ...prints, guest: print(9) }, resume, answer.message)).toBe(
    false,
  );
});
