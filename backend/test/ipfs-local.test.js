import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIpfsProvider } from "../src/ipfs.js";

test("local provider stores and retrieves content by CID", async () => {
  const dir = mkdtempSync(join(tmpdir(), "votechain-ipfs-"));
  const p = createIpfsProvider({ provider: "local", localDir: dir });
  const bytes = Buffer.from("EC8A form scan bytes");
  const { cid, size, provider } = await p.add(bytes, "ec8a.jpg", "image/jpeg");
  assert.equal(provider, "local");
  assert.equal(size, bytes.length);
  assert.match(cid, /^bafkrei/);
  assert.equal(await p.has(cid), true);
  const got = await p.get(cid);
  assert.equal(got.mime, "image/jpeg");
  assert.equal(got.bytes.toString(), "EC8A form scan bytes");
  await assert.rejects(() => p.get("bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e"), /not in the local store/);
  await assert.rejects(() => p.get("../../etc/passwd"), /invalid CID/);
});
