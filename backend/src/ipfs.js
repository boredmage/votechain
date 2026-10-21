/**
 * IPFS pipeline (Storage Layer, Section 3.3.5). Scanned EC8A–EC8D forms, dispute evidence,
 * resolution documents and the audit report are pinned to IPFS; only the CID goes on-chain.
 *
 * Providers (IPFS_PROVIDER):
 *   local  – content-addressed store on disk (backend/data/ipfs) using real CIDv1 identifiers;
 *            zero external dependencies, ideal for the demonstration and for automated tests.
 *   kubo   – a go-ipfs/Kubo daemon (docker compose up ipfs) via its HTTP API on :5001.
 *   pinata – Pinata's pinning service (PINATA_JWT).
 */
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cidV1Raw, looksLikeCid } from "./cid.js";

const SAFE_CID = /^[A-Za-z0-9]+$/;

function assertCid(cid) {
  if (!looksLikeCid(cid) || !SAFE_CID.test(cid)) {
    const err = new Error(`invalid CID: ${cid}`);
    err.status = 400;
    throw err;
  }
}

class LocalProvider {
  name = "local";

  constructor(dir) {
    this.dir = dir;
  }

  async add(bytes, filename, mime) {
    await mkdir(this.dir, { recursive: true });
    const cid = cidV1Raw(bytes);
    const file = join(this.dir, cid);
    if (!existsSync(file)) {
      await writeFile(file, bytes);
      await writeFile(`${file}.meta.json`, JSON.stringify({ filename, mime, size: bytes.length, storedAt: new Date().toISOString() }));
    }
    return { cid, size: bytes.length, provider: this.name };
  }

  async get(cid) {
    assertCid(cid);
    const file = join(this.dir, cid);
    if (!existsSync(file)) {
      const err = new Error(`CID ${cid} is not in the local store`);
      err.status = 404;
      throw err;
    }
    let mime = "application/octet-stream";
    try {
      mime = JSON.parse(await readFile(`${file}.meta.json`, "utf8")).mime || mime;
    } catch {
      /* no metadata */
    }
    const bytes = await readFile(file);
    return { bytes, mime };
  }

  async has(cid) {
    assertCid(cid);
    return existsSync(join(this.dir, cid));
  }

  gatewayUrl(cid) {
    return `/api/ipfs/${cid}`;
  }
}

class KuboProvider {
  name = "kubo";

  constructor(apiUrl, gatewayUrl) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.gateway = gatewayUrl.replace(/\/$/, "");
  }

  async add(bytes, filename, mime) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime || "application/octet-stream" }), filename || "form");
    const res = await fetch(`${this.apiUrl}/api/v0/add?cid-version=1&pin=true`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`Kubo add failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return { cid: json.Hash, size: Number(json.Size ?? bytes.length), provider: this.name };
  }

  async get(cid) {
    assertCid(cid);
    const res = await fetch(`${this.gateway}/ipfs/${cid}`);
    if (!res.ok) {
      const err = new Error(`gateway returned ${res.status} for ${cid}`);
      err.status = res.status === 404 ? 404 : 502;
      throw err;
    }
    return { bytes: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type") || "application/octet-stream" };
  }

  async has(cid) {
    assertCid(cid);
    const res = await fetch(`${this.apiUrl}/api/v0/pin/ls?arg=${cid}`, { method: "POST" });
    return res.ok;
  }

  gatewayUrl(cid) {
    return `${this.gateway}/ipfs/${cid}`;
  }
}

class PinataProvider {
  name = "pinata";

  constructor(jwt, gatewayUrl) {
    this.jwt = jwt;
    this.gateway = gatewayUrl.replace(/\/$/, "");
  }

  async add(bytes, filename, mime) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime || "application/octet-stream" }), filename || "form");
    form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
    const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.jwt}` },
      body: form,
    });
    if (!res.ok) throw new Error(`Pinata pin failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return { cid: json.IpfsHash, size: Number(json.PinSize ?? bytes.length), provider: this.name };
  }

  async get(cid) {
    assertCid(cid);
    const res = await fetch(`${this.gateway}/ipfs/${cid}`);
    if (!res.ok) {
      const err = new Error(`gateway returned ${res.status} for ${cid}`);
      err.status = res.status === 404 ? 404 : 502;
      throw err;
    }
    return { bytes: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type") || "application/octet-stream" };
  }

  async has(cid) {
    assertCid(cid);
    const res = await fetch(`https://api.pinata.cloud/data/pinList?hashContains=${cid}&status=pinned`, {
      headers: { Authorization: `Bearer ${this.jwt}` },
    });
    if (!res.ok) return false;
    const json = await res.json();
    return (json.count ?? 0) > 0;
  }

  gatewayUrl(cid) {
    return `${this.gateway}/ipfs/${cid}`;
  }
}

/** @param opts the `ipfs` section of config.js (provider, localDir, kuboApiUrl, kuboGatewayUrl, pinataJwt, pinataGatewayUrl) */
export function createIpfsProvider(opts) {
  if (!opts) throw new Error("createIpfsProvider requires the ipfs configuration");
  switch (opts.provider) {
    case "kubo":
      return new KuboProvider(opts.kuboApiUrl, opts.kuboGatewayUrl);
    case "pinata":
      if (!opts.pinataJwt) throw new Error("IPFS_PROVIDER=pinata requires PINATA_JWT");
      return new PinataProvider(opts.pinataJwt, opts.pinataGatewayUrl);
    case "local":
    default:
      return new LocalProvider(opts.localDir);
  }
}

export { assertCid };
