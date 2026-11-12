#!/usr/bin/env node
/**
 * Builds contracts/data/oyo-register.json — the demo election's geography — from INEC's polling-unit
 * register for Oyo State (state code 30): every one of its 33 LGAs, 351 registration areas (wards)
 * and 6,390 polling units, in INEC code order.
 *
 *   node scripts/build-oyo-register.mjs <Nigeria_polling_units.csv>
 *
 * Source CSV: https://github.com/Emeka-Onwuepe/Polling_Units_in_Nigeria (scraped from INEC's public
 * polling-unit locator; columns state, lg, ward, lg_code, ward_code, pu_code, code, location).
 * Names and codes are INEC's; only the letter case is normalised (the source is lower-cased).
 *
 * Registered-voter counts are NOT in the source: they are synthetic, derived from the unit code, so the
 * register is reproducible. Replace them with INEC's figures before any real use.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "contracts", "data", "oyo-register.json");
const src = process.argv[2];
if (!src) {
  console.error("usage: node scripts/build-oyo-register.mjs <Nigeria_polling_units.csv>");
  process.exit(1);
}

/** Minimal RFC 4180 parser (quoted fields, doubled quotes, embedded commas and newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(field), (field = "");
    else if (ch === "\n") row.push(field), rows.push(row), (row = []), (field = "");
    else if (ch !== "\r") field += ch;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows;
}

const ROMAN = /^(i{1,3}|iv|v|vi{1,3}|ix|x|xi{1,3})$/;
const ACRONYMS = new Set(
  "lgea lga lg aud nud cac rcm idc smb nepa phcn nta ipmc ui uch ymca ywca nurtw nysc cms ucmg adc ac sda ddc ecwa nitel ibsdlea ibedc pta gra nnpc cda dss lcda nrc sdp ict".split(" "),
);
const SMALL = new Set("at of the in and by on to".split(" "));

function word(w, first) {
  if (!w) return w;
  if (/^([a-z]\.)+[a-z]?$/.test(w)) return w.toUpperCase(); // a.u.d, l.a., c.a.c
  if (/\d/.test(w) && /[a-z]/.test(w)) return w.toUpperCase(); // n5a, sw3a, e4
  if (ROMAN.test(w) || ACRONYMS.has(w)) return w.toUpperCase();
  if (!first && SMALL.has(w)) return w;
  return w.replace(/^([^a-z]*)([a-z])/, (_, p, c) => p + c.toUpperCase());
}

function titleCase(s) {
  const clean = s
    .replace(/\s+/g, " ")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+([,.;)])/g, "$1")
    .replace(/,(?=\S)/g, ", ")
    .replace(/[\s/,;.-]+$/, "")
    .trim();
  let first = true;
  return clean.replace(/[a-z0-9.']+/g, (w) => {
    const trail = /\.$/.test(w) && !/^([a-z]\.)+$/.test(w) ? "." : "";
    const r = word(trail ? w.slice(0, -1) : w, first) + trail;
    first = false;
    return r;
  });
}

/** Ibadan's urban wards are known by short zone codes ("ward ii, n3", "s. 2b"): upper-case them whole. */
const wardName = (raw, lgaName) => {
  const name = titleCase(raw);
  return /^ibadan/i.test(lgaName) ? name.toUpperCase().replace(/^WARD\b/, "Ward") : name;
};

/** FNV-1a — a stable pseudo-random source for the synthetic register sizes. */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

const [header, ...lines] = parseCsv(readFileSync(src, "utf8"));
const col = Object.fromEntries(header.map((h, i) => [h, i]));
const lgas = new Map();
for (const r of lines) {
  if ((r[col.state] ?? "").trim().toLowerCase() !== "oyo") continue;
  const lgaCode = r[col.lg_code];
  if (!lgas.has(lgaCode)) lgas.set(lgaCode, { code: lgaCode, raw: r[col.lg], wards: new Map() });
  const lga = lgas.get(lgaCode);
  const wardCode = r[col.ward_code];
  if (!lga.wards.has(wardCode)) lga.wards.set(wardCode, { code: wardCode, raw: r[col.ward], pus: [] });
  lga.wards.get(wardCode).pus.push({ code: r[col.code], pu: r[col.pu_code], raw: r[col.location] });
}

const byCode = (a, b) => a.code.localeCompare(b.code);
const picked = [...lgas.values()].sort(byCode).map((lga) => ({ ...lga, wards: [...lga.wards.values()].sort(byCode) }));

const register = {
  state: "Oyo",
  stateCode: "30",
  source: "INEC polling-unit register (names and codes); registered-voter counts are synthetic",
  lgas: picked.map((lga) => {
    const name = titleCase(lga.raw);
    return {
      code: lga.code,
      name,
      wards: lga.wards.map((w) => ({
        code: w.code,
        name: wardName(w.raw, name),
        pollingUnits: w.pus
          .sort((a, b) => a.pu.localeCompare(b.pu))
          .map((p) => ({ code: p.code, name: titleCase(p.raw), registeredVoters: 650 + (hash(p.code) % 851) })),
      })),
    };
  }),
};

const wardCount = register.lgas.reduce((n, l) => n + l.wards.length, 0);
const puCount = register.lgas.reduce((n, l) => n + l.wards.reduce((m, w) => m + w.pollingUnits.length, 0), 0);
register.counts = { lgas: register.lgas.length, wards: wardCount, pollingUnits: puCount };
// one polling unit per line keeps the file diffable at a third of the pretty-printed size
const text = JSON.stringify(register, null, 1).replace(/\{\n\s+"code": ("[^"]*"),\n\s+"name": ("(?:[^"\\]|\\.)*"),\n\s+"registeredVoters": (\d+)\n\s+\}/g, '{ "code": $1, "name": $2, "registeredVoters": $3 }');
writeFileSync(out, text + "\n");
console.log(`wrote ${out}: ${register.lgas.length} LGAs, ${wardCount} wards, ${puCount} polling units`);
