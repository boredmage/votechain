import { Router } from "express";
import multer from "multer";
import { config } from "../config.js";
import { createIpfsProvider, assertCid } from "../ipfs.js";
import { hasDb, query } from "../db.js";

export const ipfsProvider = createIpfsProvider(config.ipfs);
export const ipfsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.ipfs.maxUploadBytes },
  fileFilter: (_req, file, cb) => {
    const ok = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/.test(file.mimetype);
    cb(ok ? null : Object.assign(new Error("only JPEG/PNG/WEBP/HEIC images or PDF documents are accepted"), { status: 415 }), ok);
  },
});

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * POST /api/ipfs/upload  (multipart/form-data: file, purpose?, uploader?)
 * Pins the scanned form / evidence / report and returns the CID to put on-chain.
 */
ipfsRouter.post(
  "/upload",
  upload.single("file"),
  wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "multipart field 'file' is required" });
    const { cid, size, provider } = await ipfsProvider.add(req.file.buffer, req.file.originalname, req.file.mimetype);
    if (hasDb()) {
      await query(
        `INSERT INTO ipfs_objects (cid, filename, mime, size, provider, uploader, purpose) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (cid) DO NOTHING`,
        [cid, req.file.originalname, req.file.mimetype, size, provider, req.body?.uploader ?? null, req.body?.purpose ?? null],
      );
    }
    res.status(201).json({ cid, size, provider, filename: req.file.originalname, mime: req.file.mimetype, url: ipfsProvider.gatewayUrl(cid) });
  }),
);

/** GET /api/ipfs/:cid — serves the object (local store) or proxies the configured gateway. */
ipfsRouter.get(
  "/:cid",
  wrap(async (req, res) => {
    assertCid(req.params.cid);
    const { bytes, mime } = await ipfsProvider.get(req.params.cid);
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(bytes);
  }),
);

/** HEAD-style existence check used by the portals to show "form available" badges. */
ipfsRouter.get(
  "/:cid/exists",
  wrap(async (req, res) => {
    assertCid(req.params.cid);
    res.json({ cid: req.params.cid, exists: await ipfsProvider.has(req.params.cid), provider: ipfsProvider.name });
  }),
);
