import { expect, test } from "bun:test";
import {
  calculateGenerator,
  type Fingerprints,
  fromBase64Url,
  generatorString,
  guestFinish,
  guestStart,
  hostFinish,
  hostRespond,
  intermediateKey,
  lvCat,
  prependLen,
  resumeAnswer,
  resumeStart,
  resumeVerify,
  scalarMultVfy,
  toBase64Url,
} from "./nearby-pake.ts";

const hex = (text: string) =>
  Uint8Array.from(text.replace(/\s/g, "").match(/../g)!, (byte) => parseInt(byte, 16));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const littleEndian = (bytes: Uint8Array) => bytes.reduceRight((n, b) => (n << 8n) | BigInt(b), 0n);
const utf8 = (text: string) => new TextEncoder().encode(text);

const print = (n: number) =>
  "sha-256 " +
  Array.from({ length: 32 }, (_, i) => ((i + n) & 0xff).toString(16).padStart(2, "0")).join(":");
const prints: Fingerprints = { guest: print(1), host: print(2) };

// draft-irtf-cfrg-cpace-21, appendix A.1 and B.3 (ristretto255, SHA-512).
test("prepend_len and lv_cat match the draft", () => {
  expect(toHex(prependLen(new Uint8Array(0)))).toBe("00");
  expect(toHex(prependLen(utf8("1234")))).toBe("0431323334");
  expect(toHex(prependLen(new Uint8Array(127))).slice(0, 2)).toBe("7f");
  expect(toHex(prependLen(new Uint8Array(128))).slice(0, 4)).toBe("8001");
  expect(toHex(prependLen(new Uint8Array(300))).slice(0, 4)).toBe("ac02");
  expect(toHex(lvCat(utf8("1234"), utf8("5"), new Uint8Array(0), utf8("678")))).toBe(
    "043132333401350003363738",
  );
});

test("CPace on ristretto255 matches the draft's test vectors", () => {
  const prs = utf8("Password");
  const ci = hex("0b415f696e69746961746f720b425f726573706f6e646572");
  const sid = hex("7e4b4791d6a8ef019b936c79fb7f2c57");
  expect(generatorString(prs, ci, sid).byteLength).toBe(170);
  const g = calculateGenerator(prs, ci, sid);
  expect(toHex(g.toBytes())).toBe(
    "222b6b195fe84b1652badb6f6a3ae3d24341e7306967f0b8115b40d5698c7e56",
  );
  const ya = littleEndian(hex("da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08"));
  const yb = littleEndian(hex("d2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d"));
  const Ya = g.multiply(ya).toBytes();
  const Yb = g.multiply(yb).toBytes();
  expect(toHex(Ya)).toBe("d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b9157");
  expect(toHex(Yb)).toBe("3ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f7258");
  const k = scalarMultVfy(ya, Yb)!;
  expect(toHex(k)).toBe("80b69a8a76457ab6a4d7f887a4bf6b55a2f80ac19c333f917a05fc9887c8b40f");
  expect(toHex(scalarMultVfy(yb, Ya)!)).toBe(toHex(k));
  expect(toHex(intermediateKey(k, Ya, Yb, { sid, ada: utf8("ADa"), adb: utf8("ADb") }))).toBe(
    "b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dcae7b35cd" +
      "2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c3fa2068af7900447",
  );
});

test("scalar_mult_vfy refuses the draft's invalid points", () => {
  const s = littleEndian(hex("7cd0e075fa7955ba52c02759a6c90dbbfc10e6d40aea8d283e407d88cf538a05"));
  const valid = hex("2c3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c");
  expect(toHex(scalarMultVfy(s, valid)!)).toBe(
    "7c13645fe790a468f62c39beb7388e541d8405d1ade69d1778c5fe3e7f6b600e",
  );
  expect(
    scalarMultVfy(s, hex("2b3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c")),
  ).toBeNull();
  expect(scalarMultVfy(s, new Uint8Array(32))).toBeNull();
});

test("base64url round-trips and refuses other lengths and non-canonical encodings", () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
  const text = toBase64Url(bytes);
  expect(text).toMatch(/^[\w-]{43}$/);
  expect(fromBase64Url(text, 32)).toEqual(bytes);
  expect(fromBase64Url(text, 31)).toBeNull();
  expect(fromBase64Url(`${text.slice(0, 42)}B`, 32)).toBeNull(); // stray low bits
  expect(fromBase64Url(`${text.slice(0, 42)}+`, 32)).toBeNull();
});

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
  // The case of the hex digits doesn't matter.
  const upper = { guest: prints.guest.toUpperCase(), host: prints.host.toUpperCase() };
  expect(run("123456", "123456", prints, upper).accepted).toBe(true);
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
    toBase64Url(fromBase64Url(tag, 32)!.map((b, i) => (i ? b : b ^ 1)));
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
  const a = guestStart("123456", prints, 12345n).message.y;
  expect(guestStart("123456", prints, 12345n).message.y).toBe(a);
  expect(guestStart("123457", prints, 12345n).message.y).not.toBe(a);
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
