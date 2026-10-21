import { test } from "node:test";
import assert from "node:assert/strict";
import { cidV1Raw, verifyCidV1Raw, looksLikeCid, parseCidV1, base32Encode, base32Decode } from "../src/cid.js";

test("CIDv1 raw sha2-256 matches the reference identifier for 'hello world'", () => {
  const cid = cidV1Raw(Buffer.from("hello world"));
  assert.equal(cid, "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e");
  assert.equal(verifyCidV1Raw(cid, Buffer.from("hello world")), true);
  assert.equal(verifyCidV1Raw(cid, Buffer.from("hello world!")), false);
});

test("parseCidV1 decodes version, codec and digest", () => {
  const p = parseCidV1(cidV1Raw(Buffer.from("hello world")));
  assert.equal(p.version, 1);
  assert.equal(p.codec, "raw");
  assert.equal(p.hashFunction, "sha2-256");
  assert.equal(p.digest, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
});

test("base32 round-trips arbitrary bytes", () => {
  for (const len of [0, 1, 2, 5, 31, 32, 33, 100]) {
    const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + len) % 256);
    assert.deepEqual(Array.from(base32Decode(base32Encode(bytes))), Array.from(bytes));
  }
});

test("looksLikeCid accepts v0 and v1 identifiers and rejects junk", () => {
  assert.equal(looksLikeCid("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"), true);
  assert.equal(looksLikeCid("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"), true);
  assert.equal(looksLikeCid("../etc/passwd"), false);
  assert.equal(looksLikeCid(""), false);
});
