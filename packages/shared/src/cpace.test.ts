import { expect, test } from "bun:test";
import {
  calculateGenerator,
  generatorString,
  intermediateKey,
  lvCat,
  prependLen,
  sampleScalar,
  scalarFromBytes,
  scalarMultVfy,
} from "./cpace.ts";

const hex = (text: string) =>
  Uint8Array.from(text.replace(/\s/g, "").match(/../g)!, (byte) => parseInt(byte, 16));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const littleEndian = (bytes: Uint8Array) => bytes.reduceRight((n, b) => (n << 8n) | BigInt(b), 0n);
const utf8 = (text: string) => new TextEncoder().encode(text);

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

test("sample_scalar is nonzero and below 2^252, and scalars read little-endian", () => {
  for (let i = 0; i < 20; i++) {
    const s = sampleScalar();
    expect(s > 0n && s < 2n ** 252n).toBe(true);
  }
  expect(scalarFromBytes(hex("0102"))).toBe(0x0201n);
});
