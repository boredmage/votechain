/**
 * Content identifiers without external dependencies.
 *
 * The "local" IPFS provider (used when no Kubo node or Pinata key is configured) content-addresses
 * every stored form image with a CIDv1 (multibase base32, codec `raw`, multihash sha2-256) — the same
 * identifier `ipfs add --cid-version=1 --raw-leaves` produces for files that fit in a single block.
 * Anybody holding the file can recompute the CID and compare it with the value recorded on-chain.
 */
import { createHash } from "node:crypto";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32 (lowercase, no padding) as used by multibase prefix `b`. */
export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of str.toLowerCase()) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character '${ch}'`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest();
}

/**
 * CIDv1 for raw bytes: <multibase b><version 0x01><codec raw 0x55><multihash sha2-256 0x12 0x20 digest>.
 * Produces identifiers of the form `bafkrei...`.
 */
export function cidV1Raw(bytes) {
  const digest = sha256(bytes);
  const multihash = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
  return "b" + base32Encode(multihash);
}

/** Returns true when `cid` is the CIDv1/raw/sha2-256 identifier of `bytes`. */
export function verifyCidV1Raw(cid, bytes) {
  return cidV1Raw(bytes) === cid;
}

/** Minimal structural check for the CID strings we accept (CIDv0 base58 or CIDv1 base32). */
export function looksLikeCid(value) {
  if (typeof value !== "string") return false;
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(value)) return true; // CIDv0 (dag-pb, base58btc)
  if (/^b[a-z2-7]{50,}$/.test(value)) return true; // CIDv1 base32
  return false;
}

/** Decodes a base32 CIDv1 into its parts (version, codec, hash function, digest hex). */
export function parseCidV1(cid) {
  if (!cid.startsWith("b")) throw new Error("only multibase base32 CIDv1 is supported here");
  const bytes = base32Decode(cid.slice(1));
  const [version, codec, hashFn, length] = bytes;
  return {
    version,
    codec: codec === 0x55 ? "raw" : codec === 0x70 ? "dag-pb" : `0x${codec.toString(16)}`,
    hashFunction: hashFn === 0x12 ? "sha2-256" : `0x${hashFn.toString(16)}`,
    digest: Buffer.from(bytes.slice(4, 4 + length)).toString("hex"),
  };
}
